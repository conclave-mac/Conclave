// Banco di valutazione offline del consiglio.
//
// USO
//   npm run eval
//     Prova di struttura con il mock (tests/chaos/mock-provider.mjs, modelli finti "eval-*" che rispondono dal
//     file delle domande secondo regole fisse in oracle.mjs). Nessun provider vero, nessuna chiave, nessuna rete
//     esterna; gira anche in CI. Fallisce (uscita 1) se le domande non sono valide, se un dibattito non finisce o
//     se le metriche non coincidono con quelle attese dalle regole del mock.
//
//   EVAL_REAL=1 EVAL_CONFIG=<config.json> npm run eval
//     Provider veri, SOLO A MANO (mai in CI). <config.json> ha la forma di models.json (providers, models, judge;
//     come COUNCIL_MODELS). Il banco rifiuta qualsiasi voce, giudice o provider Claude/Anthropic (consumerebbe
//     l'abbonamento) e prima di partire stampa quante chiamate farà almeno: per procedere va rilanciato con
//     EVAL_CONFIRM=<quel numero>. Le chiavi vanno nell'ambiente (es. GEMINI_API_KEY=…): il motore le riceve
//     come le riceverebbe dall'app. Le quote gratuite sono piccole (Gemini Flash ~20 richieste al giorno):
//     usa EVAL_LIMIT o EVAL_ONLY.
//
//   Variabili facoltative
//     EVAL_MODELS=id1,id2   voci del consiglio (predefinito: tutte quelle della config)
//     EVAL_JUDGE=id         giudice tra le voci della config (predefinito: `judge` della config)
//     EVAL_ROUNDS=0..3      round di dibattito (predefinito 1)
//     EVAL_LIMIT=n          solo le prime n domande;  EVAL_ONLY=id1,id2  solo quelle domande
//     EVAL_CONCURRENCY=n    dibattiti in parallelo (predefinito 8 col mock, 1 con provider veri)
//     EVAL_TIMEOUT_S=s      tempo massimo per dibattito (predefinito 60 col mock, 900 con provider veri)
//     EVAL_OUT=<cartella>   dove scrivere report.json e report.md (predefinito: cartella temporanea nuova)
//
// COSA MISURA (per ogni domanda un dibattito via POST /api/debates su un motore con COUNCIL_DATA temporanea)
//   - accuratezza del verdetto (sezione «## Risposta») contro la migliore risposta singola del round 0
//     (la voce con più risposte iniziali giuste) e contro «almeno una voce giusta»;
//   - accuratezza per livello di AFFIDABILITÀ (alta, media, bassa, assente) e per tipo di domanda;
//   - chiamate registrate e secondi per dibattito, round saltati (voce che salta un round), riserve usate.
//   Il criterio di correttezza di ogni domanda è in questions.json (`check`, vedi check.mjs); i testi
//   `mock.right`/`mock.wrong` servono al mock e a verificare il criterio stesso.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { isCorrect, answerSection, validateQuestions, KINDS } from "./check.mjs";
import * as oracle from "./oracle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const env = process.env;
const REAL = env.EVAL_REAL === "1";
const TOKEN = randomBytes(32).toString("hex");
const MOCK_KEY = "eval-mock-key-0123456789";
const PHASES_ROUND = ["critique", "revise", "final"];

const procs = [];
const dirs = [];
let enginePort = 0;

function fail(msg, code = 1) {
  console.error(msg);
  return cleanup().then(() => process.exit(code));
}

async function cleanup() {
  for (const p of procs) if (p.exitCode === null && !p.killed) p.kill("SIGTERM");
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
}
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

/** Avvia un processo e attende la riga `<marker>=<porta>` sullo stdout. */
function start(args, childEnv, marker, stdinLine) {
  return new Promise((ok, ko) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    procs.push(p);
    if (stdinLine) p.stdin.write(stdinLine + "\n");
    const log = [];
    p.log = log;
    let buf = "";
    const timer = setTimeout(() => ko(new Error(`${args.at(-1)}: nessuna riga ${marker} entro 20 s`)), 20_000);
    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) {
        log.push(l); if (log.length > 100) log.shift();
        const m = l.match(new RegExp(`^${marker}=(\\d+)`));
        if (m) { clearTimeout(timer); ok({ proc: p, port: Number(m[1]) }); }
      }
    });
    p.stderr.on("data", (d) => { log.push(`[stderr] ${String(d).trim()}`); if (log.length > 100) log.shift(); });
    p.on("exit", (code) => { clearTimeout(timer); ko(new Error(`${args.at(-1)} terminato (${code})`)); });
  });
}

function api(method, path, body, port = enginePort) {
  return new Promise((ok, ko) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Host: `127.0.0.1:${port}`, ...(port === enginePort ? { Authorization: `Bearer ${TOKEN}` } : {}) };
    if (data !== undefined) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
    const req = request({ host: "127.0.0.1", port, method, path, headers, timeout: 30_000 }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (s += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { /* non JSON */ } ok({ status: res.statusCode, body: j, text: s }); });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout ${method} ${path}`)));
    req.on("error", ko);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isClaude = (x) => x?.kind === "claude-cli" || /claude|anthropic/i.test(JSON.stringify(x ?? {}));
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

/** Configurazione: col mock la scrive il banco; con provider veri la legge e la controlla. */
async function loadConfig(dataDir) {
  if (!REAL) {
    if (env.EVAL_CONFIG) throw new Error("EVAL_CONFIG vale solo con EVAL_REAL=1 (senza, il banco usa sempre il mock)");
    const m = await start([join(ROOT, "tests", "chaos", "mock-provider.mjs"), "0"], { ...env }, "MOCK_PORT");
    const prov = { name: "Eval finto", baseUrl: `http://127.0.0.1:${m.port}/eval/v1`, keyEnv: "EVAL_MOCK_KEY" };
    const member = (id) => ({ id, label: id, kind: "openai", provider: "eval", model: id, family: id, default: true });
    const cfg = {
      providers: { eval: prov },
      judge: { id: oracle.JUDGE, label: "Giudice finto", kind: "openai", provider: "eval", model: oracle.JUDGE },
      models: Object.keys(oracle.MEMBERS).map(member),
    };
    return { cfg, mockPort: m.port, keys: { EVAL_MOCK_KEY: MOCK_KEY } };
  }
  if (!env.EVAL_CONFIG) throw new Error("EVAL_REAL=1 richiede EVAL_CONFIG=<config.json> passata a mano");
  const cfg = JSON.parse(await readFile(resolve(env.EVAL_CONFIG), "utf8"));
  const bad = [...(cfg.models ?? []), cfg.judge, ...Object.values(cfg.providers ?? {})].filter(isClaude);
  if (bad.length) throw new Error(`la config contiene Claude/Anthropic (${bad.map((x) => x.id ?? x.name ?? "?").join(", ")}): il banco non lo usa mai, toglilo dalla config`);
  if (!cfg.judge || !Array.isArray(cfg.models) || !cfg.models.length) throw new Error("la config deve avere models[] e judge");
  // Chiavi dall'ambiente, passate come dall'app (stessi nomi accettati da bootstrap.ts).
  const keys = Object.fromEntries(Object.entries(env).filter(([k, v]) => /^[A-Z0-9_]+_(?:KEY|TOKEN)$/.test(k) && !k.startsWith("COUNCIL_") && !/ANTHROPIC/.test(k) && v));
  return { cfg, mockPort: null, keys };
}

function pickQuestions(all) {
  let qs = all;
  if (env.EVAL_ONLY) {
    const only = new Set(env.EVAL_ONLY.split(",").map((s) => s.trim()));
    qs = qs.filter((q) => only.has(q.id));
  }
  if (env.EVAL_LIMIT) qs = qs.slice(0, Math.max(0, Number(env.EVAL_LIMIT) || 0));
  return qs;
}

/** Un dibattito: invio, attesa della fine (status non più "running") e misure. */
async function runOne(q, models, judge, rounds, timeoutS) {
  const started = Date.now();
  const question = REAL ? q.question : `${oracle.tagOf(q.id)} ${q.question}`;
  const r = await api("POST", "/api/debates", { question, models, rounds, judge, claudeModel: "haiku", webSearch: false });
  if (r.status !== 201) return { id: q.id, kind: q.kind, error: `POST → ${r.status} ${r.text.slice(0, 120)}` };
  let st = null;
  while (Date.now() - started < timeoutS * 1000) {
    await sleep(REAL ? 2000 : 250);
    const g = await api("GET", `/api/debates/${r.body.id}`);
    if (g.status === 200 && g.body.status !== "running") { st = g.body; break; }
  }
  const secs = (Date.now() - started) / 1000;
  if (!st) return { id: q.id, kind: q.kind, error: `non finito entro ${timeoutS} s`, secs };
  const msgs = st.messages ?? [];
  const work = msgs.filter((m) => !String(m.model_id).startsWith("_") && m.phase !== "research" && (m.content || m.error));
  const initial = Object.fromEntries(models.map((id) => {
    const m = msgs.find((x) => x.model_id === id && x.phase === "initial" && x.content && !x.error);
    return [id, m ? isCorrect(q.check, m.content) : false];
  }));
  const verdict = st.verdict ? answerSection(st.verdict) : "";
  return {
    id: q.id, kind: q.kind, status: st.status, secs,
    verdictCorrect: !!verdict && isCorrect(q.check, verdict),
    confidence: st.confidence ?? null,
    initial,
    calls: work.length,
    skippedRounds: work.filter((m) => m.error && PHASES_ROUND.includes(m.phase)).length,
    allSkippedNotes: msgs.filter((m) => m.model_id === "_note" && PHASES_ROUND.includes(m.phase)).length,
    replaced: work.filter((m) => m.replaced).length,
    ...(st.status !== "done" ? { error: st.error ?? `stato ${st.status}` } : {}),
  };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

function summarize(results, models) {
  const ok = results.filter((r) => !r.error);
  const n = ok.length;
  const memberAcc = Object.fromEntries(models.map((id) => [id, ok.filter((r) => r.initial[id]).length]));
  const best = models.reduce((a, b) => (memberAcc[b] > memberAcc[a] ? b : a), models[0]);
  const byConf = Object.fromEntries(["alta", "media", "bassa", "assente"].map((c) => {
    const xs = ok.filter((r) => (r.confidence ?? "assente") === c);
    return [c, { n: xs.length, correct: xs.filter((r) => r.verdictCorrect).length, accuracy: pct(xs.filter((r) => r.verdictCorrect).length, xs.length) }];
  }));
  const byKind = Object.fromEntries(KINDS.map((k) => {
    const xs = ok.filter((r) => r.kind === k);
    return [k, { n: xs.length, verdict: pct(xs.filter((r) => r.verdictCorrect).length, xs.length), best: pct(xs.filter((r) => r.initial[best]).length, xs.length) }];
  }).filter(([, v]) => v.n));
  const secs = ok.map((r) => r.secs).sort((a, b) => a - b);
  return {
    debates: results.length, finished: n, failed: results.length - n,
    verdict: { correct: ok.filter((r) => r.verdictCorrect).length, accuracy: pct(ok.filter((r) => r.verdictCorrect).length, n) },
    bestSingle: { model: best, correct: memberAcc[best], accuracy: pct(memberAcc[best], n) },
    anyMember: { correct: ok.filter((r) => models.some((id) => r.initial[id])).length, accuracy: pct(ok.filter((r) => models.some((id) => r.initial[id])).length, n) },
    members: Object.fromEntries(models.map((id) => [id, { correct: memberAcc[id], accuracy: pct(memberAcc[id], n) }])),
    byConfidence: byConf,
    byKind,
    callsPerDebate: round1(mean(ok.map((r) => r.calls))),
    secondsPerDebate: { mean: round1(mean(secs)), median: round1(secs[Math.floor(secs.length / 2)] ?? null), max: round1(secs.at(-1) ?? null) },
    skippedRounds: { total: ok.reduce((a, r) => a + r.skippedRounds, 0), debatesWithSkips: ok.filter((r) => r.skippedRounds).length, allSkippedNotes: ok.reduce((a, r) => a + r.allSkippedNotes, 0) },
    replacements: ok.reduce((a, r) => a + r.replaced, 0),
  };
}

function markdown(s, meta) {
  const rows = [
    "| Metrica | Valore |", "|---|---|",
    `| Dibattiti (finiti / falliti) | ${s.finished} / ${s.failed} |`,
    `| Verdetto giusto | ${s.verdict.correct} (${s.verdict.accuracy} %) |`,
    `| Migliore voce singola, round 0 (${s.bestSingle.model}) | ${s.bestSingle.correct} (${s.bestSingle.accuracy} %) |`,
    `| Almeno una voce giusta, round 0 | ${s.anyMember.correct} (${s.anyMember.accuracy} %) |`,
    ...Object.entries(s.members).map(([id, v]) => `| Voce ${id}, round 0 | ${v.correct} (${v.accuracy} %) |`),
    `| Chiamate per dibattito | ${s.callsPerDebate} |`,
    `| Secondi per dibattito (media / mediana / max) | ${s.secondsPerDebate.mean} / ${s.secondsPerDebate.median} / ${s.secondsPerDebate.max} |`,
    `| Round saltati (totale / dibattiti) | ${s.skippedRounds.total} / ${s.skippedRounds.debatesWithSkips} |`,
    `| Riserve usate | ${s.replacements} |`,
  ];
  const conf = ["", "| AFFIDABILITÀ | Verdetti | Giusti | Accuratezza |", "|---|---|---|---|",
    ...Object.entries(s.byConfidence).map(([c, v]) => `| ${c} | ${v.n} | ${v.correct} | ${v.accuracy ?? "—"} % |`)];
  const kinds = ["", "| Tipo | Domande | Verdetto | Migliore voce |", "|---|---|---|---|",
    ...Object.entries(s.byKind).map(([k, v]) => `| ${k} | ${v.n} | ${v.verdict} % | ${v.best} % |`)];
  return [`## Banco di valutazione (${meta.mode}, ${meta.rounds} round, ${meta.date})`, "", ...rows, ...conf, ...kinds, ""].join("\n");
}

/** Col mock i risultati devono coincidere con le regole di oracle.mjs: prova che il conteggio è giusto. */
function mockMismatches(results, s, rounds) {
  const wrong = [];
  for (const r of results) {
    if (r.error) { wrong.push(`${r.id}: ${r.error}`); continue; }
    const h = oracle.hash(r.id);
    if (r.verdictCorrect !== oracle.judgeRight(h)) wrong.push(`${r.id}: verdetto ${r.verdictCorrect ? "giusto" : "sbagliato"}, atteso il contrario`);
    if (r.confidence !== oracle.judgeConfidence(h)) wrong.push(`${r.id}: affidabilità ${r.confidence}, attesa ${oracle.judgeConfidence(h)}`);
    for (const [id, m] of Object.entries(oracle.MEMBERS)) if (r.initial[id] !== m.right(h)) wrong.push(`${r.id}: ${id} al round 0`);
    const skips = rounds >= 1 ? Object.values(oracle.MEMBERS).filter((m) => m.failsCritique(h)).length : 0;
    if (r.skippedRounds !== skips) wrong.push(`${r.id}: ${r.skippedRounds} round saltati, attesi ${skips}`);
  }
  if (s.bestSingle.model !== "eval-right" || s.bestSingle.accuracy !== 100) wrong.push(`migliore voce ${s.bestSingle.model} ${s.bestSingle.accuracy} %`);
  const confTotal = Object.values(s.byConfidence).reduce((a, v) => a + v.n, 0);
  if (confTotal !== s.finished) wrong.push(`livelli di affidabilità: ${confTotal} invece di ${s.finished}`);
  return wrong;
}

async function main() {
  const all = JSON.parse(await readFile(join(HERE, "questions.json"), "utf8"));
  const errors = validateQuestions(all);
  if (errors.length) return fail(`questions.json non valido (${errors.length} errori):\n${errors.slice(0, 10).join("\n")}`);
  const qs = pickQuestions(all);
  if (!qs.length) return fail("nessuna domanda selezionata (EVAL_ONLY/EVAL_LIMIT)");
  const rounds = Math.min(3, Math.max(0, Number(env.EVAL_ROUNDS ?? 1) || 0));

  const dataDir = await mkdtemp(join(tmpdir(), "council-eval-"));
  dirs.push(dataDir);
  const { cfg, mockPort, keys } = await loadConfig(dataDir);
  const models = env.EVAL_MODELS ? env.EVAL_MODELS.split(",").map((s) => s.trim()).filter(Boolean) : cfg.models.map((m) => m.id);
  const unknown = models.filter((id) => !cfg.models.some((m) => m.id === id));
  if (unknown.length) return fail(`EVAL_MODELS: voci assenti dalla config: ${unknown.join(", ")}`);
  if (models.length < 2 || models.length > 10) return fail("servono da 2 a 10 voci");
  // Giudice: EVAL_JUDGE = id di una voce della config; altrimenti il giudice predefinito `judge` della config,
  // che l'API chiama "claude" (DEFAULT_JUDGE in server.ts) anche quando non è Claude: qui non lo è mai (vedi sopra).
  const judge = env.EVAL_JUDGE || "claude";
  if (env.EVAL_JUDGE && !cfg.models.some((m) => m.id === env.EVAL_JUDGE)) return fail(`EVAL_JUDGE: voce assente dalla config: ${env.EVAL_JUDGE}`);

  // Chiamate minime: ogni voce una volta per fase, più il giudice; più le prove d'avvio (principale + riserve).
  const perDebate = models.length * (1 + rounds) + 1;
  const probes = [...cfg.models, cfg.judge].reduce((a, m) => a + 1 + (m.fallback?.length ?? 0), 0);
  const total = qs.length * perDebate + probes;
  console.log(`${REAL ? "PROVIDER VERI" : "mock"}: ${qs.length} domande × ${perDebate} chiamate + ~${probes} prove d'avvio = almeno ${total} chiamate` +
    (REAL ? " (riserve e nuovi tentativi in più)" : ""));
  if (REAL && env.EVAL_CONFIRM !== String(total)) return fail(`Per procedere rilancia con EVAL_CONFIRM=${total}`, 2);

  const cfgPath = join(dataDir, "eval-models.json");
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
  const childEnv = { ...env, COUNCIL_DATA: dataDir, COUNCIL_MODELS: cfgPath, PORT: "0", COUNCIL_PARENT: "app" };
  delete childEnv.ANTHROPIC_API_KEY;
  const e = await start(["--disable-warning=ExperimentalWarning", "src/server.ts"], childEnv, "COUNCIL_PORT", JSON.stringify({ token: TOKEN, keys }));
  enginePort = e.port;
  for (let i = 0; i < 120; i++) {
    const r = await api("GET", "/api/models").catch(() => null);
    if (r?.status === 200 && !r.body.checking) break;
    await sleep(500);
  }
  const callsBefore = mockPort ? (await api("GET", "/stats", undefined, mockPort)).body?.calls ?? {} : null;

  const conc = Number(env.EVAL_CONCURRENCY) || (REAL ? 1 : 8);
  const timeoutS = Number(env.EVAL_TIMEOUT_S) || (REAL ? 900 : 60);
  const t0 = Date.now();
  const results = await pool(qs, conc, async (q, i) => {
    const r = await runOne(q, models, judge, rounds, timeoutS).catch((err) => ({ id: q.id, kind: q.kind, error: err.message }));
    if (REAL) console.log(`${i + 1}/${qs.length} ${q.id}: ${r.error ?? (r.verdictCorrect ? "giusto" : "sbagliato")} (${round1(r.secs ?? 0)} s)`);
    return r;
  });
  const summary = summarize(results, models);
  if (mockPort) {
    const after = (await api("GET", "/stats", undefined, mockPort)).body?.calls ?? {};
    const evalCalls = Object.keys(after).filter((k) => k.startsWith("eval-")).reduce((a, k) => a + after[k] - (callsBefore[k] ?? 0), 0);
    summary.providerCallsPerDebate = round1(evalCalls / results.length);
  }
  const meta = { mode: REAL ? "provider veri" : "mock", rounds, date: new Date().toISOString().slice(0, 10), models, judge: env.EVAL_JUDGE || cfg.judge.id, seconds: round1((Date.now() - t0) / 1000) };
  const outDir = env.EVAL_OUT ? resolve(env.EVAL_OUT) : await mkdtemp(join(tmpdir(), "council-eval-report-"));
  await mkdir(outDir, { recursive: true });
  const md = markdown(summary, meta);
  await writeFile(join(outDir, "report.json"), JSON.stringify({ meta, summary, results }, null, 2));
  await writeFile(join(outDir, "report.md"), md);
  console.log(md);
  console.log(`Rapporto: ${join(outDir, "report.json")} e report.md (${meta.seconds} s)`);

  if (!REAL) {
    const wrong = mockMismatches(results, summary, rounds);
    if (wrong.length) return fail(`Prova di struttura FALLITA (${wrong.length}):\n${wrong.slice(0, 10).join("\n")}\n${e.proc.log.slice(-10).join("\n")}`);
    console.log("Prova di struttura: OK");
  } else if (summary.failed) {
    console.log(`Attenzione: ${summary.failed} dibattiti non finiti (vedi report.json)`);
  }
  await cleanup();
  process.exit(0);
}

main().catch((err) => fail(`Errore del banco: ${err.message}`));
