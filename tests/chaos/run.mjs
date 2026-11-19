// Test di stress del motore ("cerca di rompere le cose").
// Uso: npm run test:chaos   (oppure node tests/chaos/run.mjs [lettere scenari, es. "a,d,j"])
//
// Avvia il provider finto e il motore con dati e configurazione temporanei, esegue gli
// scenari via API e stampa PASS/FAIL. Non usa mai Claude e non tocca la cartella dati reale.

import { spawn } from "node:child_process";
import { request } from "node:http";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile, stat, readdir, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS, GEMINI_MODELS, QWEN_VISION, FAKE_GOOGLE_KEY, DOSSIER_MARK, DOSSIER_URL } from "./mock-provider.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const MIN = 60_000;

let mock, engine, dataDir, enginePort, mockPort;
/** Token dell'API del motore, passato sullo stdin come fa l'app. */
const TOKEN = randomBytes(32).toString("hex");
const CHAOS_KEY = "chaos-test-key-0123456789";
/** Chiave incollata male (a capo in mezzo): fetch fallisce prima di partire e ripete l'intestazione. */
const BAD_KEY_TAIL = "secret-ABCDEF0123456789";
const CHAOS_BAD_KEY = `chaos-bad\n${BAD_KEY_TAIL}`;
let cleaned = false;
/** Motori e cartelle in più avviati dagli scenari sulle chiavi dall'app (w, x). */
const extraProcs = [];
const extraDirs = [];

// ---------- avvio e chiusura ----------

function startProcess(cmd, args, env, marker, stdinLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    if (stdinLine) p.stdin.write(stdinLine + "\n");
    let buf = "";
    const log = [];
    p.log = log;
    const timer = setTimeout(() => reject(new Error(`${args.join(" ")}: nessuna riga ${marker} entro 20 s`)), 20_000);
    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) {
        log.push(l);
        if (log.length > 200) log.shift();
        const m = l.match(new RegExp(`^${marker}=(\\d+)`));
        if (m) { clearTimeout(timer); resolve({ proc: p, port: Number(m[1]) }); }
      }
    });
    p.stderr.on("data", (d) => { log.push(`[stderr] ${String(d).trim()}`); if (log.length > 200) log.shift(); });
    p.on("exit", (code) => { clearTimeout(timer); p.exited = code ?? "signal"; reject(new Error(`${args[args.length - 1]} terminato (${code})`)); });
  });
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const p of [engine, mock, ...extraProcs]) {
    if (p && p.exitCode === null && !p.killed) p.kill("SIGTERM");
  }
  for (const d of [dataDir, ...extraDirs]) if (d) await rm(d, { recursive: true, force: true }).catch(() => {});
}

process.on("SIGINT", async () => { console.log("\nInterrotto: chiudo mock e motore."); await cleanup(); process.exit(130); });
process.on("SIGTERM", async () => { await cleanup(); process.exit(143); });

// ---------- HTTP ----------

function api(method, path, { body, headers = {}, port = enginePort, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : raw ? String(body) : JSON.stringify(body);
    const h = { Host: `127.0.0.1:${port}`, ...(port === enginePort ? { Authorization: `Bearer ${TOKEN}` } : {}), ...headers };
    if (data !== undefined) {
      h["Content-Length"] = Buffer.byteLength(data);
      if (!Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["Content-Type"] = "application/json";
    }
    const req = request({ host: "127.0.0.1", port, method, path, headers: h, timeout: 30_000 }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (s += c));
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(s); } catch { /* non JSON */ }
        resolve({ status: res.statusCode, body: j, text: s });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout ${method} ${path}`)));
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

/** Segue gli eventi SSE di un dibattito fino all'evento "done" o alla scadenza. */
function followEvents(id, timeoutMs) {
  return new Promise((resolve) => {
    const events = [];
    let finished = false;
    const finish = (timedOut) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ events, timedOut });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const req = request({ host: "127.0.0.1", port: enginePort, path: `/api/debates/${id}/events`, headers: { Host: `127.0.0.1:${enginePort}`, Authorization: `Bearer ${TOKEN}` } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish(false); }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const e = JSON.parse(line.slice(6));
              events.push(e);
              if (e.type === "done") return finish(false);
            } catch { /* riga non JSON */ }
          }
        }
      });
      res.on("end", () => finish(false));
      res.on("error", () => finish(false));
    });
    req.on("error", () => finish(false));
    req.end();
  });
}

/** Attende che lo stato salvato non sia più "running" (dopo l'evento done può servire un attimo). */
async function finalState(id, waitMs = 5000) {
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await api("GET", `/api/debates/${id}`);
    if (r.status !== 200) return r.body;
    if (r.body.status !== "running" || Date.now() > until) return r.body;
    await new Promise((res) => setTimeout(res, 300));
  }
}

// ---------- utilità per gli scenari ----------

const QUESTION = (tag) => `[scenario:${tag}] Conviene usare il treno o l'aereo per Roma–Milano?`;

async function debate(tag, models, rounds, judge, timeoutMs, { onStart, extra } = {}) {
  const started = Date.now();
  const r = await api("POST", "/api/debates", { body: { question: QUESTION(tag), models, rounds, judge, claudeModel: "sonnet", ...extra } });
  if (r.status !== 201) throw new Error(`POST /api/debates → ${r.status} ${r.text.slice(0, 150)}`);
  const id = r.body.id;
  onStart?.(id);
  const { events, timedOut } = await followEvents(id, timeoutMs);
  const state = await finalState(id);
  return { id, events, timedOut, state, secs: (Date.now() - started) / 1000 };
}

const msgs = (state, modelId, phase) =>
  (state?.messages ?? []).filter((m) => m.model_id === modelId && (!phase || m.phase === phase));
const okMsgs = (state, modelId, phase) => msgs(state, modelId, phase).filter((m) => m.content && !m.error);
const errMsgs = (state, modelId) => msgs(state, modelId).filter((m) => m.error);
const verdictRow = (state) => (state?.messages ?? []).find((m) => m.phase === "verdict" && m.content);
const doneEvent = (events) => events.find((e) => e.type === "done");

function expectDone(res, maxSecs) {
  if (res.timedOut) return `nessun evento done entro ${maxSecs} s (stato ${res.state?.status})`;
  if (res.state?.status !== "done") {
    const d = doneEvent(res.events);
    return `stato "${res.state?.status}"${d?.error ? `: ${d.error}` : ""}`;
  }
  if (!res.state.verdict) return "stato done ma verdetto vuoto";
  return null;
}

// ---------- scenari ----------

const PHASES = ["initial", "critique", "revise", "final"];

const SCENARIOS = {
  async a() {
    const max = 120;
    const r = await debate("a", ["ok-a", "ok-b"], 3, "ok-a", max * 1000);
    const bad = expectDone(r, max);
    if (bad) return [false, bad, r.secs];
    const missing = [];
    for (const m of ["ok-a", "ok-b"]) for (const p of PHASES) if (!okMsgs(r.state, m, p).length) missing.push(`${m}/${p}`);
    if (missing.length) return [false, `messaggi mancanti: ${missing.join(", ")}`, r.secs];
    const all = r.state.messages.filter((m) => m.content).map((m) => m.content).join("");
    const info = `U+202F ${all.includes(" ") ? "presente" : "assente"}, U+2011 ${all.includes("‑") ? "presente" : "assente"} nel testo salvato`;
    return [true, `done, 4 fasi per entrambi, verdetto di ${verdictRow(r.state)?.model_id} (${info})`, r.secs];
  },

  // Un modello bloccato non deve fermare gli altri: ok-a e ok-b discutono tutti i round.
  async b() {
    const max = 240;
    const r = await debate("b", ["ok-a", "ok-b", "hang"], 2, "ok-b", max * 1000);
    const bad = expectDone(r, max);
    if (bad) return [false, `${bad} dopo ${r.secs.toFixed(0)} s`, r.secs];
    const phases = ["initial", "critique", "revise"];
    const missing = [];
    for (const m of ["ok-a", "ok-b"]) for (const p of phases) if (!okMsgs(r.state, m, p).length) missing.push(`${m}/${p}`);
    if (missing.length) {
      const herr = errMsgs(r.state, "hang").map((m) => `${m.phase}: ${m.error.slice(0, 60)}`).join("; ");
      return [false, `done ma messaggi mancanti: ${missing.join(", ")} (errori hang → ${herr || "nessuno"})`, r.secs];
    }
    return [true, `done in ${r.secs.toFixed(0)} s, ok-a e ok-b in tutte le fasi, hang escluso`, r.secs];
  },

  // Ritardatario: la risposta iniziale lo aspetta (40 s < 45 s); nel round, quando gli altri hanno finito,
  // ha ancora al massimo 30 s dall'inizio del round, poi salta il round senza uscire dal dibattito.
  async lag() {
    const max = 180;
    const r = await debate("lag", ["ok-a", "ok-b", "lag"], 1, "ok-a", max * 1000);
    const bad = expectDone(r, max);
    if (bad) return [false, `${bad} dopo ${r.secs.toFixed(0)} s`, r.secs];
    if (!okMsgs(r.state, "lag", "initial").length) return [false, "risposta iniziale di lag non attesa", r.secs];
    const crit = msgs(r.state, "lag", "critique")[0];
    if (!crit?.error?.includes("troppo lento")) return [false, `critica di lag: ${crit?.error ?? crit?.content?.slice(0, 40) ?? "assente"}`, r.secs];
    // Iniziale ~40 s + round ~30 s + giudice: ben sotto i 40 + 45 s che servirebbero senza la regola.
    if (r.secs > 80) return [false, `troppo lungo: ${r.secs.toFixed(0)} s`, r.secs];
    return [true, `done in ${r.secs.toFixed(0)} s, lag atteso nella risposta iniziale e fermato nel round`, r.secs];
  },

  // Se resta un solo modello i round si saltano, ma va detto (nota salvata nella cronologia).
  async b2() {
    const max = 120;
    const r = await debate("b2", ["ok-a", "crash500"], 2, "ok-b", max * 1000);
    const bad = expectDone(r, max);
    if (bad) return [false, `${bad} dopo ${r.secs.toFixed(0)} s`, r.secs];
    const note = r.state.messages.find((m) => m.model_id === "_note");
    if (!note) return [false, "done ma nessuna nota sui round saltati", r.secs];
    return [true, `done, nota presente: "${note.content.slice(0, 50)}"`, r.secs];
  },

  async c() {
    const max = 240;
    const r = await debate("c", ["ok-a", "flaky-critique"], 3, "ok-a", max * 1000);
    const bad = expectDone(r, max);
    if (bad) return [false, bad, r.secs];
    const back = okMsgs(r.state, "flaky-critique", "revise").length + okMsgs(r.state, "flaky-critique", "final").length;
    const failedR1 = errMsgs(r.state, "flaky-critique").some((m) => m.phase === "critique");
    if (!back) {
      return [false, `flaky-critique non rientra dopo il round 1 (errore in critique: ${failedR1 ? "sì" : "no"}; fasi con messaggi: ${
        PHASES.filter((p) => okMsgs(r.state, "flaky-critique", p).length).join(", ") || "nessuna"})`, r.secs];
    }
    return [true, `done, flaky-critique rientra (critique fallita: ${failedR1 ? "sì" : "no"})`, r.secs];
  },

  async d() {
    const max = 180;
    const r = await debate("d", ["ok-a", "ratelimit"], 1, "ok-b", max * 1000);
    const bad = expectDone(r, max);
    if (bad) return [false, bad, r.secs];
    const errs = errMsgs(r.state, "ratelimit");
    if (errs.length) return [false, `errori definitivi per ratelimit: ${errs.map((e) => `${e.phase}: ${e.error.slice(0, 80)}`).join("; ")}`, r.secs];
    const missing = ["initial", "critique"].filter((p) => !okMsgs(r.state, "ratelimit", p).length);
    if (missing.length) return [false, `ratelimit senza messaggi in: ${missing.join(", ")}`, r.secs];
    const ms = okMsgs(r.state, "ratelimit", "initial")[0]?.ms;
    return [true, `done, ratelimit riuscito dopo l'attesa (initial ${ms} ms)`, r.secs];
  },

  async e() {
    const max = 240;
    const r = await debate("e", ["ok-a", "ok-b"], 1, "hang", max * 1000);
    const bad = expectDone(r, max);
    if (bad) return [false, `${bad} dopo ${r.secs.toFixed(0)} s`, r.secs];
    const v = verdictRow(r.state);
    if (!v || v.model_id === "judge:hang") return [false, `verdetto non da un giudice di riserva (${v?.model_id})`, r.secs];
    const tried = (r.state.messages ?? []).filter((m) => m.phase === "verdict" && m.error).map((m) => m.model_id).join(", ");
    return [true, `verdetto da ${v.model_id} in ${r.secs.toFixed(0)} s (falliti: ${tried || "nessuno"})`, r.secs];
  },

  async f() {
    const max = 60;
    const r = await debate("f", ["ok-a", "html"], 0, "ok-a", max * 1000);
    const bad = expectDone(r, max);
    if (bad) return [false, bad, r.secs];
    const t = okMsgs(r.state, "html", "initial")[0]?.content ?? "";
    const need = ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "[x](javascript:alert(1))"];
    const lost = need.filter((s) => !t.includes(s));
    if (lost.length) return [false, `il motore ha alterato il testo: mancano ${lost.join(" | ")}`, r.secs];
    return [true, "done, tag salvati intatti (escape lasciato all'interfaccia; md() non testata)", r.secs];
  },

  async g() {
    const max = 180;
    const r = await debate("g", ["ok-a", "empty", "crash500", "gone"], 1, "ok-a", max * 1000);
    const bad = expectDone(r, max);
    if (bad) return [false, bad, r.secs];
    if (!okMsgs(r.state, "ok-a", "initial").length) return [false, "ok-a senza risposta iniziale", r.secs];
    const problems = [];
    for (const m of ["empty", "crash500", "gone"]) {
      if (!errMsgs(r.state, m).length) problems.push(`${m}: nessun errore registrato`);
      if (okMsgs(r.state, m).length) problems.push(`${m}: ha messaggi validi`);
    }
    if (problems.length) return [false, problems.join("; "), r.secs];
    const notes = ["empty", "crash500", "gone"].map((m) => `${m}=${errMsgs(r.state, m)[0].error.slice(0, 40)}`).join(" | ");
    return [true, `done con ok-a; errori: ${notes}`, r.secs];
  },

  async h() {
    const max = 120;
    const r = await debate("h", ["ok-a", "huge"], 1, "ok-b", max * 1000);
    const bad = expectDone(r, max);
    const alive = engine.exitCode === null;
    const m = await api("GET", "/api/models").catch((e) => ({ status: String(e.message) }));
    if (!alive || m.status !== 200) return [false, `motore non raggiungibile dopo huge (vivo: ${alive}, /api/models: ${m.status})`, r.secs];
    if (bad) return [false, bad, r.secs];
    const len = okMsgs(r.state, "huge", "initial")[0]?.content?.length ?? 0;
    return [true, `done, motore raggiungibile, testo huge salvato ${len} caratteri`, r.secs];
  },

  async i() {
    const started = Date.now();
    let id;
    const p = debate("i", ["ok-a", "slow"], 3, "ok-b", 40_000, { onStart: (x) => (id = x) });
    await new Promise((res) => setTimeout(res, 3000));
    const c = await api("POST", `/api/debates/${id}/cancel`, { body: {} });
    if (c.status !== 200) return [false, `cancel → ${c.status}`, (Date.now() - started) / 1000];
    const tCancel = Date.now();
    const r = await p;
    const after = (Date.now() - tCancel) / 1000;
    if (r.state?.status !== "cancelled") return [false, `stato "${r.state?.status}" dopo l'annullamento`, r.secs];
    if (after > 30) return [false, `annullato ma dopo ${after.toFixed(1)} s (> 30 s)`, r.secs];
    return [true, `cancelled ${after.toFixed(1)} s dopo la richiesta`, r.secs];
  },

  async j() {
    const started = Date.now();
    const base = { question: QUESTION("j"), models: ["ok-a", "ok-b"], rounds: 1, judge: "ok-a", claudeModel: "sonnet" };
    const cases = [
      ["question vuota", { body: { ...base, question: "   " } }, 400],
      ["1 solo modello", { body: { ...base, models: ["ok-a"] } }, 400],
      ["rounds 9", { body: { ...base, rounds: 9 } }, 400],
      ["judge inesistente", { body: { ...base, judge: "nessuno" } }, 400],
      ["Content-Type text/plain", { body: JSON.stringify(base), raw: true, headers: { "Content-Type": "text/plain" } }, 415],
      ["Host evil.com", { body: base, headers: { Host: "evil.com" } }, 403],
      ["JSON rovinato", { body: "{question:", raw: true, headers: { "Content-Type": "application/json" } }, 400],
      ["models non array", { body: { ...base, models: "ok-a" } }, 400],
      ["rounds stringa", { body: { ...base, rounds: "2" } }, 400],
      ["modello duplicato (resta 1 solo)", { body: { ...base, models: ["ok-a", "ok-a"] } }, 400],
      ["11 partecipanti (max 10)", { body: { ...base, models: ["ok-a", "ok-b", "hang", "slow", "ratelimit", "quota", "crash500", "empty", "huge", "html", "flaky-critique"] } }, 400],
      ["domanda di 150.000 caratteri", { body: { ...base, question: "x".repeat(150_000) } }, 400],
      ["senza token", { body: base, headers: { Authorization: "" } }, 401],
      ["token sbagliato", { body: base, headers: { Authorization: `Bearer ${"0".repeat(64)}` } }, 401],
      ["token come cookie/query", { body: base, headers: { Authorization: "", Cookie: `token=${TOKEN}` } }, 401],
    ];
    const wrong = [];
    for (const [name, opts, want] of cases) {
      const r = await api("POST", "/api/debates", opts).catch((e) => ({ status: `errore ${e.message}` }));
      // Per gli ultimi casi (non richiesti) basta un 4xx: nessun dibattito avviato, nessun 500.
      const lenient = ["JSON rovinato", "models non array", "rounds stringa", "domanda di 150.000 caratteri"].includes(name);
      const ok = lenient ? typeof r.status === "number" && r.status >= 400 && r.status < 500 : r.status === want;
      if (!ok) wrong.push(`${name}: atteso ${lenient ? "4xx" : want}, avuto ${r.status}`);
    }
    const secs = (Date.now() - started) / 1000;
    if (wrong.length) return [false, wrong.join("; "), secs];
    return [true, `${cases.length} richieste non valide respinte con il codice giusto`, secs];
  },

  async l() {
    // Extra: quota esaurita (nessuna attesa inutile) e risposta troncata per lunghezza.
    const max = 120;
    const r = await debate("l", ["ok-a", "quota", "length"], 1, "ok-a", max * 1000);
    const bad = expectDone(r, max);
    if (bad) return [false, bad, r.secs];
    const problems = [];
    if (!errMsgs(r.state, "quota").length) problems.push("quota: nessun errore registrato");
    const len = okMsgs(r.state, "length", "initial")[0]?.content ?? "";
    if (!/troncat/i.test(len)) problems.push("length: manca l'avviso di troncamento");
    const stats = await api("GET", "/stats", { port: mockPort });
    const qcalls = stats.body?.calls?.quota ?? 0;
    if (qcalls > 2) problems.push(`quota chiamato ${qcalls} volte (riprova inutile su quota esaurita)`);
    if (problems.length) return [false, problems.join("; "), r.secs];
    return [true, `done, quota escluso subito (${qcalls} chiamate), length segnalato come troncato`, r.secs];
  },
};

SCENARIOS.m = async function m() {
  const max = 150;
  const r = await debate("m", ["ok-a", "voce"], 0, "ok-a", max * 1000);
  const bad = expectDone(r, max);
  if (bad) return [false, bad, r.secs];
  const msg = r.state.messages.find((x) => x.model_id === "voce" && x.phase === "initial");
  if (!msg?.content) return [false, `la voce non ha risposto (errore: ${msg?.error?.slice(0, 80) ?? "nessun messaggio"})`, r.secs];
  if (msg.model_used !== "ok-b") return [false, `ha risposto ${msg.model_used}, atteso ok-b (riserva)`, r.secs];
  return [true, `done, risposta della riserva ok-b${msg.replaced ? ` al posto di ${msg.replaced}` : ""} in ${(msg.ms / 1000).toFixed(0)} s`, r.secs];
};

// La voce resta sulla riserva: dopo il primo timeout il modello bloccato non viene più chiamato.
SCENARIOS.n = async function n() {
  const max = 200;
  const r = await debate("n", ["ok-a", "voce"], 2, "ok-a", max * 1000);
  const bad = expectDone(r, max);
  if (bad) return [false, bad, r.secs];
  const msgs = r.state.messages.filter((x) => x.model_id === "voce" && x.content);
  if (msgs.length < 3) return [false, `la voce ha risposto in ${msgs.length} fasi su 3`, r.secs];
  // Dopo la prima fase la voce deve usare subito la riserva: niente nuove attese da 35 s.
  const later = msgs.filter((x) => x.phase !== "initial");
  const slow = later.filter((x) => (x.ms ?? 0) > 10_000 || x.model_used !== "ok-b");
  if (slow.length) return [false, `nei round successivi la voce ha riatteso o cambiato modello: ${slow.map((x) => `${x.phase} ${x.model_used} ${Math.round(x.ms / 1000)} s`).join(", ")}`, r.secs];
  return [true, `done in ${r.secs.toFixed(0)} s, dopo il primo timeout la voce resta su ok-b (round successivi ${later.map((x) => Math.round(x.ms) + " ms").join(", ")})`, r.secs];
};

// Limite di token in uscita (Qwen su Groq): l'app abbassa max_tokens e riprova subito.
SCENARIOS.o = async function o() {
  const max = 60;
  const r = await debate("o", ["ok-a", "otpm"], 1, "ok-a", max * 1000);
  const bad = expectDone(r, max);
  if (bad) return [false, bad, r.secs];
  const ok = r.state.messages.filter((x) => x.model_id === "otpm" && x.content).length;
  if (ok < 2) return [false, `otpm ha risposto in ${ok} fasi su 2 (errori: ${errMsgs(r.state, "otpm").map((m) => m.error.slice(0, 60)).join("; ")})`, r.secs];
  return [true, `done, otpm ha risposto in tutte le fasi abbassando max_tokens`, r.secs];
};

// Chiavi mai visibili: il provider ripete la chiave nell'errore, ma né cronologia, né eventi,
// né log del motore devono contenerla (né il token dell'API).
SCENARIOS.p = async function p() {
  const max = 60;
  const r = await debate("p", ["ok-a", "ok-b", "leaky", "badkey"], 0, "ok-a", max * 1000);
  const bad = expectDone(r, max);
  if (bad) return [false, bad, r.secs];
  const err = errMsgs(r.state, "leaky")[0]?.error ?? "";
  if (!err) return [false, "leaky senza errore registrato", r.secs];
  if (!errMsgs(r.state, "badkey").length) return [false, "badkey senza errore registrato", r.secs];
  const where = { cronologia: JSON.stringify(r.state), eventi: JSON.stringify(r.events), log: engine.log.join("\n") };
  const leaks = Object.entries(where).flatMap(([k, t]) =>
    [[CHAOS_KEY, "chiave"], [BAD_KEY_TAIL, "chiave rovinata"], [FAKE_GOOGLE_KEY, "AIza"], [TOKEN, "token"]].filter(([v]) => t.includes(v)).map(([, n]) => `${n} in ${k}`));
  if (leaks.length) return [false, `segreti visibili: ${leaks.join(", ")}`, r.secs];
  if (!err.includes("[chiave nascosta]")) return [false, `errore senza maschera: ${err.slice(0, 80)}`, r.secs];
  return [true, `done, errore mascherato: "${err.slice(0, 70)}…"`, r.secs];
};

// File dei dati leggibili solo dall'utente (cartelle 0700, file 0600).
SCENARIOS.q = async function q() {
  const started = Date.now();
  const open = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (f.endsWith("models.chaos.json")) continue; // scritto dalla suite, non dal motore
      const mode = (await stat(f)).mode & 0o777;
      if (mode & 0o077) open.push(`${f.slice(dataDir.length + 1)} ${mode.toString(8)}`);
      if (e.isDirectory()) await walk(f);
    }
  };
  await walk(dataDir);
  const secs = (Date.now() - started) / 1000;
  if (open.length) return [false, `leggibili da altri: ${open.slice(0, 5).join(", ")}`, secs];
  return [true, "database, WAL e file del motore solo per l'utente", secs];
};

// Corpo con accenti spezzato a metà carattere tra due pacchetti; corpi "null" → 400, mai 500.
SCENARIOS.r = async function r() {
  const started = Date.now();
  const question = `[scenario:r] Perché l'università è così? ${"àèìòù€ ".repeat(40)}`;
  const body = Buffer.from(JSON.stringify({ question, models: ["ok-a", "ok-b"], rounds: 0, judge: "ok-a", claudeModel: "sonnet" }));
  const cut = body.indexOf(Buffer.from("€")) + 1; // dentro i 3 byte di "€"
  const text = await new Promise((resolve, reject) => {
    const sock = connect(enginePort, "127.0.0.1", () => {
      sock.write(`POST /api/debates HTTP/1.1\r\nHost: 127.0.0.1:${enginePort}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
      sock.write(body.subarray(0, cut));
      setTimeout(() => sock.write(body.subarray(cut)), 150);
    });
    let s = "";
    sock.setEncoding("utf8");
    sock.on("data", (c) => (s += c));
    sock.on("end", () => resolve(s));
    sock.on("error", reject);
  });
  const secs = () => (Date.now() - started) / 1000;
  const id = Number(text.match(/"id":(\d+)/)?.[1]);
  if (!id) return [false, `dibattito non creato: ${text.slice(0, 80)}`, secs()];
  const saved = (await api("GET", `/api/debates/${id}`)).body?.question;
  if (saved !== question.trim()) return [false, `domanda alterata (${[...(saved ?? "")].filter((c) => c === "\ufffd").length} caratteri rovinati)`, secs()];
  const wrong = [];
  for (const [method, path] of [["POST", "/api/probe"], ["PUT", "/api/selection"], ["POST", "/api/debates"]]) {
    for (const raw of ["null", "[]", '"x"']) {
      const x = await api(method, path, { body: raw, raw: true, headers: { "Content-Type": "application/json" } });
      if (x.status !== 400) wrong.push(`${method} ${path} ${raw} → ${x.status}`);
    }
  }
  if (wrong.length) return [false, wrong.join("; "), secs()];
  return [true, "domanda intatta, 9 corpi non-oggetto respinti con 400", secs()];
};

// Eliminare un dibattito in corso: sparisce, non restano righe orfane, il motore resta vivo.
SCENARIOS.s = async function s() {
  const started = Date.now();
  const c = await api("POST", "/api/debates", { body: { question: QUESTION("s"), models: ["ok-a", "slow"], rounds: 1, judge: "ok-a", claudeModel: "sonnet" } });
  const id = c.body?.id;
  await new Promise((res) => setTimeout(res, 1000));
  const d = await api("DELETE", `/api/debates/${id}`);
  await new Promise((res) => setTimeout(res, 1500));
  const g = await api("GET", `/api/debates/${id}`);
  const db = new DatabaseSync(join(dataDir, "data", "council.db"), { readOnly: true });
  const orphans = db.prepare("SELECT count(*) AS n FROM messages WHERE debate_id = ?").get(id).n;
  db.close();
  const secs = (Date.now() - started) / 1000;
  if (d.status !== 200 || g.status !== 404) return [false, `DELETE ${d.status}, poi GET ${g.status}`, secs];
  if (orphans) return [false, `${orphans} messaggi orfani dopo l'eliminazione`, secs];
  if (engine.exitCode !== null) return [false, "motore terminato", secs];
  return [true, "eliminato a metà: GET 404, nessun messaggio orfano", secs];
};

// Chi si scollega e si ricollega a metà riceve di nuovo tutti gli eventi dall'inizio.
SCENARIOS.t = async function t() {
  const started = Date.now();
  const c = await api("POST", "/api/debates", { body: { question: QUESTION("t"), models: ["ok-a", "slow"], rounds: 0, judge: "ok-a", claudeModel: "sonnet" } });
  const id = c.body?.id;
  const first = await followEvents(id, 2000);
  const second = await followEvents(id, 60_000);
  const secs = (Date.now() - started) / 1000;
  if (!first.timedOut) return [false, "il dibattito è finito prima dello scollegamento", secs];
  if (second.events[0]?.type !== "start") return [false, `il replay non riparte da start (${second.events[0]?.type})`, secs];
  if (second.events.length < first.events.length) return [false, "replay più corto degli eventi già visti", secs];
  if (doneEvent(second.events)?.status !== "done") return [false, `nessun done dopo il ricollegamento`, secs];
  return [true, `ricollegato: ${second.events.length} eventi da start a done`, secs];
};

// Riga del titolo: solo in testa e sulla sua riga, senza mangiare il verdetto.
SCENARIOS.u = async function u() {
  const { splitTitle } = await import("../../src/debate/prompts.ts");
  const cases = [
    ["TITOLO: Treno o aereo\n\n## Verdetto\nTesto", "Treno o aereo", "## Verdetto\nTesto"],
    ["**TITLE:** Train or plane\nText", "Train or plane", "Text"],
    ["**TITOLO**: Grassetto fuori\nTesto", "Grassetto fuori", "Testo"],
    ["## TITOLO: Con cancelletto\nTesto", "Con cancelletto", "Testo"],
    ["TITOLO:\n## Risposta\nTesto", null, "## Risposta\nTesto"],
    ["Nessun titolo qui.\nTesto", null, "Nessun titolo qui.\nTesto"],
    [`${"x".repeat(300)}\nTITOLO: Tardi\nTesto`, null, `${"x".repeat(300)}\nTITOLO: Tardi\nTesto`],
  ];
  const wrong = cases.filter(([input, title, verdict]) => {
    const r = splitTitle(input);
    return r.title !== title || r.verdict !== verdict;
  }).map(([input]) => JSON.stringify(input.slice(0, 30)));
  if (wrong.length) return [false, `casi sbagliati: ${wrong.join(", ")}`, 0];
  return [true, `${cases.length} casi di titolo corretti`, 0];
};

// Giudice che scrive solo il titolo: il verdetto vuoto non si accetta, decide la riserva.
SCENARIOS.v = async function v() {
  const max = 60;
  const r = await debate("v", ["ok-a", "ok-b"], 0, "titleonly", max * 1000);
  const bad = expectDone(r, max);
  if (bad) return [false, bad, r.secs];
  const row = verdictRow(r.state);
  if (!row || row.model_id === "judge:titleonly") return [false, `verdetto accettato da ${row?.model_id}`, r.secs];
  const failed = (r.state.messages ?? []).find((m) => m.model_id === "judge:titleonly" && m.error);
  if (!failed) return [false, "nessun errore registrato per il giudice a verdetto vuoto", r.secs];
  return [true, `verdetto vuoto scartato (${failed.error}), deciso da ${row.model_id}`, r.secs];
};

// ---------- chiavi dall'app (hello sullo stdin) ----------

/** Ambiente pulito per un motore in più: nessuna chiave delle prove ereditata dal runner. */
function cleanEnv(extra) {
  const env = { ...process.env, PORT: "0", COUNCIL_PARENT: "app", ...extra };
  for (const k of Object.keys(env)) if (/_(API_)?KEY$|_TOKEN$/.test(k) || k === "NODE_OPTIONS") delete env[k];
  return env;
}

/** Avvia un motore separato (dati e config propri) con la riga di hello data. */
async function startExtraEngine(cfg, hello, { dotenv, env: extra } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "council-chaos-keys-"));
  extraDirs.push(dir);
  const cfgPath = join(dir, "models.json");
  await writeFile(cfgPath, JSON.stringify(cfg));
  if (dotenv) await writeFile(join(dir, ".env"), dotenv);
  const e = await startProcess(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.ts"],
    cleanEnv({ COUNCIL_DATA: dir, COUNCIL_MODELS: cfgPath, ...extra }), "COUNCIL_PORT", hello);
  extraProcs.push(e.proc);
  e.proc.removeAllListeners("exit");
  e.proc.on("exit", (code) => { e.proc.exited = code ?? "signal"; });
  return { ...e, dir };
}

const authed = (tok) => ({ Authorization: `Bearer ${tok}` });

// Chiavi passate dall'app sullo stdin: arrivano al provider (con precedenza su .env), la Claude
// CLI non le eredita, e se il provider le ripete nell'errore non compaiono in log né cronologia.
SCENARIOS.w = async function w() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const tok = randomBytes(32).toString("hex");
  const APP_KEY = "app-keychain-key-" + randomBytes(12).toString("hex");
  const DOTENV_KEY = "dotenv-key-should-lose-0123456789";
  // Finta Claude CLI: risponde con i nomi delle variabili sensibili che ha ereditato.
  const bin = await mkdtemp(join(tmpdir(), "council-chaos-bin-"));
  extraDirs.push(bin);
  await writeFile(join(bin, "claude"), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on("end",()=>{const n=Object.keys(process.env).filter(k=>/_KEY$|_TOKEN$|^COUNCIL_/.test(k));process.stdout.write(JSON.stringify({result:"ENV["+n.join(",")+"]"}))});\n`);
  await chmod(join(bin, "claude"), 0o755);
  const cfg = {
    providers: { app: { name: "Dall'app", baseUrl: `http://127.0.0.1:${mockPort}/v1`, keyEnv: "APP_PROV_API_KEY" } },
    judge: { id: "j", label: "Giudice", kind: "openai", provider: "app", model: "whoami" },
    models: [
      { id: "whoami", label: "Whoami", kind: "openai", provider: "app", model: "whoami", family: "whoami", default: false },
      { id: "leaky", label: "Leaky", kind: "openai", provider: "app", model: "leaky", family: "leaky", default: false },
      { id: "fakeclaude", label: "Finta Claude", kind: "claude-cli", model: "sonnet", default: false },
    ],
  };
  const e = await startExtraEngine(cfg, JSON.stringify({ token: tok, keys: { APP_PROV_API_KEY: APP_KEY } }),
    { dotenv: `APP_PROV_API_KEY=${DOTENV_KEY}\n`, env: { PATH: `${bin}:${process.env.PATH}` } });
  const c = await api("POST", "/api/debates", { port: e.port, headers: authed(tok),
    body: { question: QUESTION("w"), models: ["whoami", "leaky", "fakeclaude"], rounds: 0, judge: "whoami", claudeModel: "sonnet" } });
  if (c.status !== 201) return [false, `POST /api/debates → ${c.status}`, secs()];
  let state;
  for (let i = 0; i < 100; i++) {
    state = (await api("GET", `/api/debates/${c.body.id}`, { port: e.port, headers: authed(tok) })).body;
    if (state?.status && state.status !== "running") break;
    await new Promise((res) => setTimeout(res, 300));
  }
  if (state?.status !== "done") return [false, `stato "${state?.status}"`, secs()];
  const got = (await api("GET", "/stats", { port: mockPort })).body?.auths?.whoami;
  if (got !== `Bearer ${APP_KEY}`) return [false, `il provider ha ricevuto ${got?.includes(DOTENV_KEY) ? "la chiave di .env" : "un'altra intestazione"}`, secs()];
  const claudeOut = okMsgs(state, "fakeclaude")[0]?.content ?? "";
  if (!claudeOut.startsWith("ENV[")) return [false, `finta Claude senza risposta: ${claudeOut.slice(0, 60)}`, secs()];
  if (/APP_PROV_API_KEY|COUNCIL_/.test(claudeOut)) return [false, `la Claude CLI eredita: ${claudeOut.slice(0, 80)}`, secs()];
  const err = errMsgs(state, "leaky")[0]?.error ?? "";
  if (!err.includes("[chiave nascosta]")) return [false, `errore di leaky senza maschera`, secs()];
  const where = { cronologia: JSON.stringify(state), log: e.proc.log.join("\n") };
  const leaks = Object.entries(where).flatMap(([k, t]) =>
    [[APP_KEY, "chiave dall'app"], [DOTENV_KEY, "chiave di .env"], [tok, "token"]].filter(([v]) => t.includes(v)).map(([, n]) => `${n} in ${k}`));
  if (leaks.length) return [false, `segreti visibili: ${leaks.join(", ")}`, secs()];
  return [true, `Bearer dall'app (non .env), Claude CLI senza chiavi, errore mascherato`, secs()];
};

// Hello ostili: il motore parte comunque e nessun campo non valido diventa una variabile.
SCENARIOS.x = async function x() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const names = ["HOSTILE_API_KEY", "HOSTILE2_API_KEY", "HOSTILE3_API_KEY", "HOSTILE4_API_KEY", "HOSTILE5_API_KEY",
    "HOSTILE6_API_KEY", "HOSTILE7_TOKEN", "NODE_OPTIONS", "COUNCIL_TEST_TOKEN", "VALID_API_KEY"];
  const providers = Object.fromEntries(names.map((n) => [n.toLowerCase().replace(/_/g, "-"), { baseUrl: `http://127.0.0.1:${mockPort}/v1`, keyEnv: n }]));
  const first = Object.keys(providers)[0];
  const cfg = {
    providers,
    judge: { id: "j", label: "Giudice", kind: "openai", provider: first, model: "ok-a" },
    models: [{ id: "m", label: "M", kind: "openai", provider: first, model: "ok-a", family: "m", default: false }],
  };
  const secretValues = ["valid-looking-key-123", "lowercase-key-1234", "trailing-space-name-123", "no-suffix-12345",
    "--require=/nonexistent/x.js", "test-token-that-should-not-apply-0123456789", "break-123456", "y".repeat(5000)];
  const mixed = {
    "__proto__": { HOSTILE_API_KEY: secretValues[0] },
    "hostile_api_key": secretValues[1],
    "HOSTILE_API_KEY ": secretValues[2],
    "HOSTILE_API": secretValues[3],
    "NODE_OPTIONS": secretValues[4],
    "COUNCIL_TEST_TOKEN": secretValues[5],
    "HOSTILE2_API_KEY": `line\n${secretValues[6]}`,
    "HOSTILE3_API_KEY": secretValues[7],
    "HOSTILE4_API_KEY": 12345678901,
    "HOSTILE5_API_KEY": "",
    "HOSTILE6_API_KEY": "short",
    "HOSTILE7_TOKEN": { nested: "object-value-12345" },
    "VALID_API_KEY": "valid-key-0123456789",
  };
  const hellos = [["stringa", "HOSTILE_API_KEY=abc12345678"], ["array", ["HOSTILE_API_KEY", "abc12345678"]], ["null", null], ["numero", 42], ["misto", mixed]];
  const tok = randomBytes(32).toString("hex");
  // JSON.stringify ignora "__proto__" scritto in un letterale (è il prototipo): lo si inserisce a mano.
  const helloText = (keys) => JSON.stringify({ token: tok, keys }).replace('"keys":{', `"keys":{"__proto__":${JSON.stringify(mixed.__proto__)},`);
  const wrong = [];
  await Promise.all(hellos.map(async ([label, keys]) => {
    let e;
    try {
      e = await startExtraEngine(cfg, label === "misto" ? helloText(keys) : JSON.stringify({ token: tok, keys }));
    } catch (err) { wrong.push(`${label}: motore non partito (${err.message})`); return; }
    const r = await api("GET", "/api/providers", { port: e.port, headers: authed(tok) });
    if (r.status !== 200) { wrong.push(`${label}: /api/providers ${r.status}`); return; }
    const set = r.body.filter((p) => p.hasKey).map((p) => providers[p.id]?.keyEnv ?? p.id);
    const expected = label === "misto" ? ["VALID_API_KEY"] : [];
    if (set.join() !== expected.join()) wrong.push(`${label}: chiavi impostate [${set.join(",")}]`);
    const log = e.proc.log.join("\n");
    const shown = secretValues.filter((v) => log.includes(v.slice(0, 40)));
    if (shown.length) wrong.push(`${label}: ${shown.length} valori nel log`);
    if (e.proc.exited !== undefined) wrong.push(`${label}: motore terminato`);
  }));
  if (wrong.length) return [false, wrong.join("; "), secs()];
  return [true, `${hellos.length} hello ostili: motore vivo, solo VALID_API_KEY impostata, nessun valore nel log`, secs()];
};

// Motore ucciso (SIGKILL, come un crash) con un dibattito "running": riavviato sulla stessa cartella
// dati, il dibattito risulta "interrupted" sia nel dettaglio sia nella lista, e non è più live.
SCENARIOS.y = async function y() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const dir = await mkdtemp(join(tmpdir(), "council-chaos-restart-"));
  extraDirs.push(dir);
  const cfgPath = join(dir, "models.json");
  await writeFile(cfgPath, JSON.stringify({
    providers: { chaos: { name: "Chaos", baseUrl: `http://127.0.0.1:${mockPort}/v1`, keyEnv: "CHAOS_KEY" } },
    judge: { id: "j", label: "Giudice", kind: "openai", provider: "chaos", model: "ok-a" },
    models: [
      { id: "lento", label: "Lento", kind: "openai", provider: "chaos", model: "slow", family: "lento", default: false },
      { id: "bloccato", label: "Bloccato", kind: "openai", provider: "chaos", model: "hang", family: "bloccato", default: false },
    ],
  }));
  const boot = async () => {
    const tok = randomBytes(32).toString("hex");
    const e = await startProcess(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.ts"],
      cleanEnv({ COUNCIL_DATA: dir, COUNCIL_MODELS: cfgPath }), "COUNCIL_PORT", JSON.stringify({ token: tok, keys: { CHAOS_KEY } }));
    extraProcs.push(e.proc);
    e.proc.removeAllListeners("exit");
    e.proc.on("exit", (code) => { e.proc.exited = code ?? "signal"; });
    return { ...e, h: authed(tok) };
  };
  const e1 = await boot();
  const c = await api("POST", "/api/debates", { port: e1.port, headers: e1.h,
    body: { question: QUESTION("y"), models: ["lento", "bloccato"], rounds: 1, judge: "lento", claudeModel: "sonnet" } });
  if (c.status !== 201) return [false, `POST /api/debates → ${c.status}`, secs()];
  const id = c.body.id;
  // Attende che il dibattito sia davvero in corso (salvato come running) prima del crash.
  await new Promise((res) => setTimeout(res, 1500));
  const before = await api("GET", `/api/debates/${id}`, { port: e1.port, headers: e1.h });
  if (before.body?.status !== "running") return [false, `prima del crash stato "${before.body?.status}"`, secs()];
  const gone = new Promise((res) => e1.proc.once("exit", res));
  e1.proc.kill("SIGKILL");
  await gone;
  const e2 = await boot();
  const d = await api("GET", `/api/debates/${id}`, { port: e2.port, headers: e2.h });
  if (d.status !== 200) return [false, `GET dopo il riavvio → ${d.status}`, secs()];
  if (d.body.status !== "interrupted") return [false, `stato dopo il riavvio "${d.body.status}"`, secs()];
  if (d.body.live) return [false, "dibattito interrotto ancora segnato live", secs()];
  const l = await api("GET", "/api/debates", { port: e2.port, headers: e2.h });
  const row = Array.isArray(l.body) ? l.body.find((x) => x.id === id) : null;
  if (!row) return [false, `dibattito assente dalla lista (${l.status})`, secs()];
  if (row.status !== "interrupted") return [false, `nella lista stato "${row.status}"`, secs()];
  const ev = await api("GET", `/api/debates/${id}/events`, { port: e2.port, headers: e2.h });
  if (ev.status !== 404) return [false, `flusso eventi di un dibattito interrotto → ${ev.status}`, secs()];
  e2.proc.kill("SIGTERM");
  return [true, `dopo SIGKILL e riavvio: interrupted in dettaglio e lista, non live, eventi 404`, secs()];
};

// Giudice lento (mock "slow", 20 s): il flusso SSE non deve restare muto più di HEARTBEAT_MAX_S
// mentre il giudice lavora. Si contano anche i commenti SSE (righe ":"), che fanno da heartbeat.
// I tempi del motore non sono configurabili: lo scenario dura ~25 s.
const HEARTBEAT_MAX_S = 16;
SCENARIOS.z = async function z() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const c = await api("POST", "/api/debates", { body: { question: QUESTION("z"), models: ["ok-a", "ok-b"], rounds: 0, judge: "slow", claudeModel: "sonnet" } });
  if (c.status !== 201) return [false, `POST /api/debates → ${c.status}`, secs()];
  const id = c.body.id;
  const res = await new Promise((resolve) => {
    let last = Date.now(), maxGap = 0, comments = 0, judgeAt = null, done = false, buf = "";
    const finish = (timedOut) => {
      clearTimeout(timer);
      req.destroy();
      resolve({ maxGap, comments, judgeAt, done, timedOut });
    };
    const timer = setTimeout(() => finish(true), 60_000);
    const req = request({ host: "127.0.0.1", port: enginePort, path: `/api/debates/${id}/events`, headers: { Host: `127.0.0.1:${enginePort}`, Authorization: `Bearer ${TOKEN}` } }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return finish(false); }
      r.setEncoding("utf8");
      r.on("data", (chunk) => {
        const now = Date.now();
        // Il silenzio conta solo durante il giudice: prima i modelli ok rispondono subito.
        if (judgeAt !== null) maxGap = Math.max(maxGap, (now - last) / 1000);
        last = now;
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) comments++;
            if (!line.startsWith("data: ")) continue;
            try {
              const e = JSON.parse(line.slice(6));
              if (e.type === "phase" && e.phase === "verdict" && judgeAt === null) judgeAt = now;
              if (e.type === "done") { done = true; return finish(false); }
            } catch { /* riga non JSON */ }
          }
        }
      });
      r.on("end", () => finish(false));
    });
    req.on("error", () => finish(false));
    req.end();
  });
  if (res.timedOut || !res.done) return [false, `nessun evento done (${res.timedOut ? "scaduto" : "flusso chiuso"})`, secs()];
  if (res.judgeAt === null) return [false, "nessun evento phase del giudice nel flusso", secs()];
  if (res.maxGap > HEARTBEAT_MAX_S)
    return [false, `DIFETTO: flusso muto ${res.maxGap.toFixed(1)} s durante il giudice (${res.comments} heartbeat; il motore non manda commenti SSE)`, secs()];
  return [true, `silenzio massimo ${res.maxGap.toFixed(1)} s, ${res.comments} heartbeat`, secs()];
};

// ---------- ricerca sul web e allegati ----------

const RESEARCH_TIMEOUT_S = 6;
const promptsOf = async (tag) => (await api("GET", `/prompts/${tag}`, { port: mockPort })).body ?? [];
const phaseEvent = (events, phase) => events.findIndex((e) => e.type === "phase" && e.phase === phase);

// Ricerca via Groq finto: fase research prima di initial, dossier ripulito dai rimandi 【…】 e con le
// pagine consultate, nel prompt iniziale e del giudice ma non nei round intermedi.
SCENARIOS.aa = async function aa() {
  const max = 90;
  const ws = (await api("GET", "/api/models")).body?.webSearch;
  if (!ws?.available || ws.via !== "GPT-OSS (Groq)") return [false, `/api/models webSearch = ${JSON.stringify(ws)}`, 0];
  const r = await debate("web-ok", ["ok-a", "ok-b"], 1, "ok-a", max * 1000, { extra: { webSearch: true } });
  const bad = expectDone(r, max);
  if (bad) return [false, bad, r.secs];
  const iR = phaseEvent(r.events, "research"), iI = phaseEvent(r.events, "initial");
  if (iR < 0 || iI < 0 || iR > iI) return [false, `ordine delle fasi sbagliato (research ${iR}, initial ${iI})`, r.secs];
  const ev = r.events.find((e) => e.type === "message" && e.phase === "research");
  if (ev?.modelId !== "research:gptoss" || !/gpt-oss/.test(ev.model ?? "")) return [false, `evento research: ${JSON.stringify(ev)?.slice(0, 100)}`, r.secs];
  const row = okMsgs(r.state, "research:gptoss", "research")[0];
  if (!row) return [false, "dossier non salvato nella cronologia", r.secs];
  if (row.content.includes("【")) return [false, "rimandi 【…】 non ripuliti", r.secs];
  if (!row.content.includes(DOSSIER_URL) || !row.content.includes("https://example.org/altra")) return [false, "fonti mancanti nel dossier", r.secs];
  if (r.state.options?.webSearch !== true) return [false, `options.webSearch = ${r.state.options?.webSearch}`, r.secs];
  const pr = await promptsOf("web-ok");
  const search = pr.filter((p) => p.phase === "research");
  if (search.length !== 1) return [false, `${search.length} richieste di ricerca (attesa 1)`, r.secs];
  if (search[0].reasoning_effort !== "low" || !/gpt-oss-(120b|20b)$/.test(search[0].model)) return [false, `ricerca con ${search[0].model}, reasoning ${search[0].reasoning_effort}`, r.secs];
  const wrong = [];
  for (const p of pr.filter((x) => x.phase !== "research")) {
    const has = p.user.includes("RISULTATI DELLA RICERCA SUL WEB") && p.user.includes(DOSSIER_MARK);
    const want = p.phase === "initial" || p.phase === "verdict";
    if (has !== want) wrong.push(`${p.phase}/${p.model}: dossier ${has ? "presente" : "assente"}`);
  }
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), r.secs];
  return [true, `research prima di initial, dossier ripulito con fonti, nei prompt iniziali e del giudice (${pr.length} prompt)`, r.secs];
};

// Nessuno può cercare (niente Claude, niente GPT-OSS su Groq): nota e il dibattito prosegue.
SCENARIOS.ab = async function ab() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const tok = randomBytes(32).toString("hex");
  const prov = { baseUrl: `http://127.0.0.1:${mockPort}/v1`, keyEnv: "CHAOS_KEY" };
  const cfg = {
    providers: { chaos: { name: "Chaos", ...prov } },
    judge: { id: "j", label: "Giudice", kind: "openai", provider: "chaos", model: "ok-a" },
    models: [
      { id: "ok-a", label: "A", kind: "openai", provider: "chaos", model: "ok-a", family: "ok-a", default: false },
      { id: "ok-b", label: "B", kind: "openai", provider: "chaos", model: "ok-b", family: "ok-b", default: false },
      // GPT-OSS ma non su Groq: non conta come ricercatore.
      { id: "gptoss", label: "GPT-OSS altrove", kind: "openai", provider: "chaos", model: "openai/gpt-oss-120b", family: "gpt-oss", default: false },
    ],
  };
  const e = await startExtraEngine(cfg, JSON.stringify({ token: tok, keys: { CHAOS_KEY } }));
  const ws = (await api("GET", "/api/models", { port: e.port, headers: authed(tok) })).body?.webSearch;
  if (!ws || ws.available !== false || ws.via !== null) return [false, `/api/models webSearch = ${JSON.stringify(ws)}`, secs()];
  const c = await api("POST", "/api/debates", { port: e.port, headers: authed(tok),
    body: { question: QUESTION("web-none"), models: ["ok-a", "ok-b"], rounds: 0, judge: "ok-a", claudeModel: "sonnet", webSearch: true } });
  if (c.status !== 201) return [false, `POST /api/debates → ${c.status}`, secs()];
  let state;
  for (let i = 0; i < 100; i++) {
    state = (await api("GET", `/api/debates/${c.body.id}`, { port: e.port, headers: authed(tok) })).body;
    if (state?.status && state.status !== "running") break;
    await new Promise((res) => setTimeout(res, 300));
  }
  e.proc.kill("SIGTERM");
  if (state?.status !== "done") return [false, `stato "${state?.status}"`, secs()];
  const note = state.messages.find((m) => m.model_id === "_note" && m.phase === "research");
  if (!note) return [false, "nessuna nota sulla ricerca non disponibile", secs()];
  if (state.messages.some((m) => m.phase === "research" && m.model_id !== "_note")) return [false, "messaggi di ricerca senza ricercatore", secs()];
  return [true, `done, nota: "${note.content.slice(0, 50)}…"`, secs()];
};

// Ricercatore bloccato: errore non fatale entro il tempo massimo, poi il dibattito prosegue senza dossier.
SCENARIOS.ac = async function ac() {
  const max = 90;
  const r = await debate("web-hang", ["ok-a", "ok-b"], 0, "ok-a", max * 1000, { extra: { webSearch: true } });
  const bad = expectDone(r, max);
  if (bad) return [false, bad, r.secs];
  const err = r.events.find((e) => e.type === "error" && e.phase === "research");
  if (err?.modelId !== "research") return [false, `nessun errore di ricerca (${JSON.stringify(err)?.slice(0, 80)})`, r.secs];
  if (!errMsgs(r.state, "research").length) return [false, "errore di ricerca non salvato", r.secs];
  if (r.secs > RESEARCH_TIMEOUT_S + 15) return [false, `troppo lento: ${r.secs.toFixed(0)} s`, r.secs];
  const pr = await promptsOf("web-hang");
  if (pr.some((p) => p.user.includes("RISULTATI DELLA RICERCA SUL WEB"))) return [false, "blocco di ricerca nei prompt senza dossier", r.secs];
  return [true, `done in ${r.secs.toFixed(0)} s, errore non fatale: "${err.error.slice(0, 60)}…"`, r.secs];
};

const ATT_LONG = `INIZIO-ALL-1 ${"clausola di prova. ".repeat(300)} FINE-ALL-1`;

// Allegati validi: testo completo nel prompt iniziale e del giudice, estratto nei round intermedi,
// solo metadati nella cronologia, testo completo nel DB; non passano all'approfondimento.
SCENARIOS.ad = async function ad() {
  const max = 120;
  const attachments = [
    { name: "contratto.pdf", kind: "pdf", text: ATT_LONG },
    { name: "note\n## finto titolo", kind: "text", text: "INIZIO-ALL-2 testo breve FINE-ALL-2" },
  ];
  const r = await debate("att-ok", ["ok-a", "ok-b"], 2, "ok-a", max * 1000, { extra: { attachments } });
  const bad = expectDone(r, max);
  if (bad) return [false, bad, r.secs];
  const meta = msgs(r.state, "_attachments", "start")[0];
  let list = null;
  try { list = JSON.parse(meta?.content ?? "null"); } catch { /* sotto */ }
  if (!Array.isArray(list) || list.length !== 2 || list[0].chars !== ATT_LONG.length || list[1].kind !== "text") return [false, `metadati _attachments: ${meta?.content?.slice(0, 100)}`, r.secs];
  if (JSON.stringify(r.state).includes("FINE-ALL-1")) return [false, "testo completo degli allegati restituito all'app", r.secs];
  const db = new DatabaseSync(join(dataDir, "data", "council.db"), { readOnly: true });
  const stored = db.prepare("SELECT text FROM attachments WHERE debate_id = ? ORDER BY id").all(r.id).map((x) => x.text);
  db.close();
  if (stored[0] !== ATT_LONG) return [false, `testo nel DB: ${stored.length} righe, primo ${stored[0]?.length} caratteri`, r.secs];
  const pr = await promptsOf("att-ok");
  const wrong = [];
  for (const p of pr) {
    const full = p.user.includes("ALLEGATI:\n### contratto.pdf") && p.user.includes("FINE-ALL-1") && p.user.includes("FINE-ALL-2");
    const excerpt = p.user.includes("solo un estratto") && p.user.includes("INIZIO-ALL-1") && !p.user.includes("FINE-ALL-1");
    if (p.user.includes("\n## finto titolo")) wrong.push(`${p.phase}: nome con a capo non ripulito`);
    if ((p.phase === "initial" || p.phase === "verdict") && !full) wrong.push(`${p.phase}/${p.model}: allegati non completi`);
    if ((p.phase === "critique" || p.phase === "revise") && !excerpt) wrong.push(`${p.phase}/${p.model}: estratto assente o troppo lungo`);
  }
  const phases = new Set(pr.map((p) => p.phase));
  for (const ph of ["initial", "critique", "revise", "verdict"]) if (!phases.has(ph)) wrong.push(`nessun prompt ${ph}`);
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), r.secs];
  // Approfondimento: solo domanda e verdetto della discussione madre.
  const c = await api("POST", "/api/debates", { body: { question: QUESTION("att-child"), models: ["ok-a", "ok-b"], rounds: 0, judge: "ok-a", claudeModel: "sonnet", parentId: r.id } });
  if (c.status !== 201) return [false, `approfondimento → ${c.status}`, r.secs];
  const child = await followEvents(c.body.id, 60_000);
  if (doneEvent(child.events)?.status !== "done") return [false, "approfondimento non concluso", r.secs];
  const cp = await promptsOf("att-child");
  const init = cp.find((p) => p.phase === "initial");
  if (!init?.user.includes("DISCUSSIONE PRECEDENTE")) return [false, `approfondimento senza contesto (${cp.map((p) => p.phase).join(",")}: ${init?.user.slice(0, 80)})`, r.secs];
  if (cp.some((p) => p.user.includes("INIZIO-ALL") || p.user.includes("ALLEGATI"))) return [false, "allegati della madre passati all'approfondimento", r.secs];
  return [true, `allegati completi in initial/verdict, estratto in critique/revise, metadati in cronologia, testo nel DB, non ereditati`, r.secs];
};

// Allegati oltre i limiti o malformati, webSearch non booleano, corpo enorme: 400/413, mai 500.
SCENARIOS.ae = async function ae() {
  const started = Date.now();
  const base = { question: QUESTION("att-bad"), models: ["ok-a", "ok-b"], rounds: 0, judge: "ok-a", claudeModel: "sonnet" };
  const a = (text, extra = {}) => ({ name: "a.txt", kind: "text", text, ...extra });
  const cases = [
    ["attachments non elenco", { attachments: "x" }, 400],
    ["attachments oggetto", { attachments: { name: "a" } }, 400],
    ["6 allegati", { attachments: Array(6).fill(a("x")) }, 400],
    ["allegato null", { attachments: [null] }, 400],
    ["allegato elenco", { attachments: [["a"]] }, 400],
    ["kind sconosciuto", { attachments: [a("x", { kind: "exe" })] }, 400],
    ["kind mancante", { attachments: [{ name: "a", text: "x" }] }, 400],
    ["text numero", { attachments: [a(42)] }, 400],
    ["name mancante", { attachments: [{ kind: "pdf", text: "x" }] }, 400],
    ["nome di 201 caratteri", { attachments: [a("x", { name: "n".repeat(201) })] }, 400],
    ["testo di 40.001 caratteri", { attachments: [a("x".repeat(40_001))] }, 400],
    ["totale 60.002 caratteri", { attachments: [a("x".repeat(30_001)), a("y".repeat(30_001))] }, 400],
    ["webSearch stringa", { webSearch: "yes" }, 400],
    ["webSearch numero", { webSearch: 1 }, 400],
    ["corpo > 1.000.000 caratteri", { attachments: [a("x".repeat(1_010_000))] }, 413],
  ];
  const wrong = [];
  for (const [name, extra, want] of cases) {
    const r = await api("POST", "/api/debates", { body: { ...base, ...extra } }).catch((e) => ({ status: `errore ${e.message}` }));
    if (r.status !== want) wrong.push(`${name}: atteso ${want}, avuto ${r.status}`);
  }
  // Nessun dibattito creato dalle richieste respinte.
  const list = (await api("GET", "/api/debates?q=att-bad")).body ?? [];
  if (list.length) wrong.push(`${list.length} dibattiti creati da richieste non valide`);
  const secs = (Date.now() - started) / 1000;
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs];
  return [true, `${cases.length} richieste non valide respinte con il codice giusto, nessun dibattito creato`, secs];
};

// Allegati esattamente al limite (5 × 12.000 = 60.000 caratteri) e un modello con il limite di token
// al minuto di Groq gratis: quel modello esce in modo pulito (una chiamata, nessun ciclo), gli altri proseguono.
SCENARIOS.af = async function af() {
  const max = 90;
  const attachments = Array.from({ length: 5 }, (_, i) => ({ name: `parte-${i + 1}.txt`, kind: "text", text: `P${i}`.padEnd(12_000, "z") }));
  const before = (await api("GET", "/stats", { port: mockPort })).body?.calls?.tpm ?? 0;
  const r = await debate("att-max", ["ok-a", "ok-b", "tpm"], 1, "ok-a", max * 1000, { extra: { attachments } });
  const bad = expectDone(r, max);
  if (bad) return [false, bad, r.secs];
  const calls = ((await api("GET", "/stats", { port: mockPort })).body?.calls?.tpm ?? 0) - before;
  const err = errMsgs(r.state, "tpm")[0]?.error ?? "";
  if (!/too large|413/i.test(err)) return [false, `tpm senza errore "too large" (${err.slice(0, 60) || "nessuno"})`, r.secs];
  if (calls > 2) return [false, `tpm chiamato ${calls} volte (riprova inutile)`, r.secs];
  if (!okMsgs(r.state, "ok-a", "critique").length) return [false, "ok-a senza critica: i round non sono proseguiti", r.secs];
  return [true, `done con 60.000 caratteri di allegati; tpm escluso dopo ${calls} chiamata/e: "${err.slice(0, 50)}…"`, r.secs];
};

// Annullamento mentre il ricercatore lavora: si ferma subito, nessuna risposta iniziale.
SCENARIOS.ag = async function ag() {
  const started = Date.now();
  let id;
  const p = debate("web-cancel-hang", ["ok-a", "ok-b"], 1, "ok-a", 40_000, { onStart: (x) => (id = x), extra: { webSearch: true } });
  // Come in "at": si annulla solo quando l'id è arrivato (runner lenti).
  for (let i = 0; i < 100 && id === undefined; i++) await new Promise((res) => setTimeout(res, 100));
  await new Promise((res) => setTimeout(res, 1500));
  const c = await api("POST", `/api/debates/${id}/cancel`, { body: {} });
  if (c.status !== 200) return [false, `cancel → ${c.status}`, (Date.now() - started) / 1000];
  const tCancel = Date.now();
  const r = await p;
  const after = (Date.now() - tCancel) / 1000;
  if (r.state?.status !== "cancelled") return [false, `stato "${r.state?.status}" dopo l'annullamento`, r.secs];
  if (after > 3) return [false, `annullato ma dopo ${after.toFixed(1)} s`, r.secs];
  if (phaseEvent(r.events, "initial") >= 0) return [false, "la fase iniziale è partita dopo l'annullamento", r.secs];
  if (r.events.some((e) => e.type === "error" && e.phase === "research")) return [false, "annullamento registrato come errore di ricerca", r.secs];
  return [true, `cancelled ${after.toFixed(1)} s dopo la richiesta, durante la ricerca`, r.secs];
};

// Ricerca con Claude (finta CLI nel PATH, mai quella vera): solo WebSearch/WebFetch concessi, isolamento
// invariato (MCP, impostazioni, ambiente senza chiavi); da partecipante resta senza strumenti.
SCENARIOS.ah = async function ah() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const tok = randomBytes(32).toString("hex");
  const bin = await mkdtemp(join(tmpdir(), "council-chaos-bin-"));
  extraDirs.push(bin);
  await writeFile(join(bin, "claude"), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on("end",()=>{const n=Object.keys(process.env).filter(k=>/_KEY$|^COUNCIL_/.test(k));process.stdout.write(JSON.stringify({result:"ARGS"+JSON.stringify(process.argv.slice(2).filter(a=>a.length<80))+"ENV["+n.join(",")+"]"}))});\n`);
  await chmod(join(bin, "claude"), 0o755);
  const cfg = {
    providers: { chaos: { name: "Chaos", baseUrl: `http://127.0.0.1:${mockPort}/v1`, keyEnv: "CHAOS_KEY" } },
    judge: { id: "j", label: "Giudice", kind: "openai", provider: "chaos", model: "ok-a" },
    models: [
      { id: "ok-a", label: "A", kind: "openai", provider: "chaos", model: "ok-a", family: "ok-a", default: false },
      { id: "fakeclaude", label: "Finta Claude", kind: "claude-cli", model: "sonnet", default: false },
    ],
  };
  const e = await startExtraEngine(cfg, JSON.stringify({ token: tok, keys: { CHAOS_KEY } }), { env: { PATH: `${bin}:${process.env.PATH}` } });
  const ws = (await api("GET", "/api/models", { port: e.port, headers: authed(tok) })).body?.webSearch;
  if (ws?.via !== "Claude") return [false, `/api/models webSearch = ${JSON.stringify(ws)}`, secs()];
  const c = await api("POST", "/api/debates", { port: e.port, headers: authed(tok),
    body: { question: QUESTION("web-claude"), models: ["ok-a", "fakeclaude"], rounds: 0, judge: "ok-a", claudeModel: "haiku", webSearch: true } });
  if (c.status !== 201) return [false, `POST /api/debates → ${c.status}`, secs()];
  let state;
  for (let i = 0; i < 100; i++) {
    state = (await api("GET", `/api/debates/${c.body.id}`, { port: e.port, headers: authed(tok) })).body;
    if (state?.status && state.status !== "running") break;
    await new Promise((res) => setTimeout(res, 300));
  }
  e.proc.kill("SIGTERM");
  if (state?.status !== "done") return [false, `stato "${state?.status}"`, secs()];
  const res = okMsgs(state, "research:fakeclaude", "research")[0];
  const part = okMsgs(state, "fakeclaude", "initial")[0];
  if (!res || !part) return [false, `ricerca ${res ? "ok" : "assente"}, partecipante ${part ? "ok" : "assente"}`, secs()];
  const args = (t) => JSON.parse(t.match(/^ARGS(\[.*\])ENV/)?.[1] ?? "[]");
  const ra = args(res.content), pa = args(part.content);
  const after = (list, flag) => list[list.indexOf(flag) + 1];
  const wrong = [];
  if (after(ra, "--tools") !== "WebSearch,WebFetch" || after(ra, "--allowedTools") !== "WebSearch,WebFetch") wrong.push(`ricerca: strumenti ${after(ra, "--tools")}`);
  if (after(pa, "--tools") !== "" || pa.includes("--allowedTools")) wrong.push(`partecipante: strumenti ${JSON.stringify(after(pa, "--tools"))}`);
  for (const f of ["--strict-mcp-config", "--no-session-persistence"]) if (!ra.includes(f)) wrong.push(`ricerca senza ${f}`);
  if (after(ra, "--setting-sources") !== "") wrong.push("ricerca con impostazioni utente");
  if (after(ra, "--model") !== "haiku") wrong.push(`ricerca con modello ${after(ra, "--model")}`);
  if (!/ENV\[\]/.test(res.content)) wrong.push(`ambiente: ${res.content.match(/ENV\[.*\]/)?.[0]}`);
  if (wrong.length) return [false, wrong.join("; "), secs()];
  return [true, "ricerca con solo WebSearch/WebFetch e isolamento invariato; partecipante senza strumenti", secs()];
};

// ---------- chat continua: turni dopo il verdetto ----------

const FQ = (tag, text) => `[scenario:${tag}] ${text}`;
const followupPath = (id) => `/api/debates/${id}/followups`;
const turnMsgs = (state, turn) => (state?.messages ?? []).filter((m) => (m.turn ?? 0) === turn);

/** Domanda di seguito: POST, poi segue il flusso del turno fino a done e rilegge lo stato. */
async function turnOf(id, body, timeoutMs) {
  const started = Date.now();
  const post = await api("POST", followupPath(id), { body: { claudeModel: "sonnet", ...body } });
  if (post.status !== 201) return { post, events: [], state: null, secs: (Date.now() - started) / 1000 };
  const { events, timedOut } = await followEvents(id, timeoutMs);
  const state = await finalState(id);
  return { post, turn: post.body?.turn, events, timedOut, state, secs: (Date.now() - started) / 1000 };
}

/** Dibattito di partenza concluso (2 modelli ok, nessun round). */
async function baseDebate(tag, extra) {
  const r = await debate(tag, ["ok-a", "ok-b"], 0, "ok-a", 60_000, { extra });
  const bad = expectDone(r, 60);
  if (bad) throw new Error(`dibattito di partenza: ${bad}`);
  return r;
}

// Risposta rapida: turno 1 con eventi tutti marcati, cronologia del turno, verdetto e titolo invariati,
// prompt con domanda originale, allegati completi, verdetto e nuova domanda (in quest'ordine).
SCENARIOS.ai = async function ai() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const r = await baseDebate("conv-quick", { attachments: [{ name: "orari.txt", kind: "text", text: "INIZIO-CONV-ALL orari dei treni FINE-CONV-ALL" }] });
  const NEWQ = FQ("conv-quick", "E se viaggio di notte?");
  const t = await turnOf(r.id, { question: NEWQ, responder: "ok-b", attachments: [{ name: "nota.txt", kind: "text", text: "INIZIO-TURNO-ALL nota del turno FINE-TURNO-ALL" }] }, 60_000);
  if (t.post.status !== 201 || t.turn !== 1) return [false, `POST followups → ${t.post.status} ${t.post.text.slice(0, 100)}`, secs()];
  const wrong = [];
  const att = turnMsgs(t.state, 1).find((m) => m.model_id === "_attachments");
  if (!att?.content?.includes("nota.txt")) wrong.push("_attachments del turno mancante");
  if (JSON.stringify(t.state).includes("FINE-TURNO-ALL")) wrong.push("testo degli allegati del turno restituito all'app");
  const first = t.events[0];
  if (first?.type !== "turn" || first.turn !== 1 || first.mode !== "quick" || first.question !== NEWQ) wrong.push(`primo evento ${JSON.stringify(first)?.slice(0, 80)}`);
  if (t.events.some((e) => e.turn !== 1)) wrong.push("eventi senza turn: 1");
  const msg = t.events.find((e) => e.type === "message");
  if (msg?.phase !== "answer" || msg.modelId !== "ok-b") wrong.push(`messaggio ${msg?.phase}/${msg?.modelId}`);
  const done = doneEvent(t.events);
  if (done?.status !== "done" || "title" in done) wrong.push(`done ${JSON.stringify(done)}`);
  if (t.state?.status !== "done") wrong.push(`stato ${t.state?.status}`);
  if (t.state?.verdict !== r.state.verdict || t.state?.title !== r.state.title) wrong.push("verdetto o titolo del turno 0 cambiati");
  const m1 = turnMsgs(t.state, 1);
  const user = m1.find((m) => m.model_id === "_user");
  if (user?.phase !== "followup" || user.content !== NEWQ) wrong.push("messaggio _user mancante");
  let meta = null;
  try { meta = JSON.parse(m1.find((m) => m.model_id === "_meta" && m.phase === "turn")?.content ?? "null"); } catch { /* sotto */ }
  if (meta?.mode !== "quick" || meta.judge !== "ok-b" || meta.webSearch !== false) wrong.push(`_meta del turno ${JSON.stringify(meta)}`);
  if (!m1.some((m) => m.model_id === "ok-b" && m.phase === "answer" && m.content)) wrong.push("risposta non salvata nel turno 1");
  if (turnMsgs(t.state, 0).length + m1.length !== t.state.messages.length) wrong.push("messaggi con turn diverso da 0/1");
  const p = (await promptsOf("conv-quick")).filter((x) => x.phase === "answer");
  if (p.length !== 1) wrong.push(`${p.length} prompt di risposta rapida`);
  else {
    const u = p[0].user;
    const at = (s) => u.indexOf(s);
    const keys = ["CONVERSAZIONE FINORA", QUESTION("conv-quick"), "FINE-CONV-ALL", r.state.verdict.slice(0, 200), `NUOVA DOMANDA:\n${NEWQ}`];
    const missing = keys.filter((k) => at(k) < 0);
    if (missing.length) wrong.push(`prompt senza: ${missing.map((k) => k.slice(0, 30)).join(" | ")}`);
    else if (at(r.state.verdict.slice(0, 200)) > at("NUOVA DOMANDA")) wrong.push("verdetto dopo la nuova domanda");
    if (at("FINE-TURNO-ALL") < at("NUOVA DOMANDA")) wrong.push("allegato del turno assente o prima della nuova domanda");
    if (/giudice/i.test(p[0].system)) wrong.push("il risponditore riceve il prompt del giudice");
  }
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs()];
  return [true, "turno 1: eventi marcati, cronologia del turno, verdetto/titolo invariati, contesto completo nel prompt", secs()];
};

// Risponditore bloccato: dopo il tempo massimo risponde una riserva della catena, e lo si dice.
SCENARIOS.aj = async function aj() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const r = await baseDebate("conv-hang");
  const t = await turnOf(r.id, { question: FQ("conv-hang", "E con i bagagli?"), responder: "hang" }, 240_000);
  if (t.post.status !== 201) return [false, `POST followups → ${t.post.status}`, secs()];
  if (t.timedOut) return [false, "nessun done entro 240 s", secs()];
  if (t.state?.status !== "done") return [false, `stato ${t.state?.status} (${doneEvent(t.events)?.error})`, secs()];
  const err = t.events.find((e) => e.type === "error" && e.modelId === "hang");
  const msg = t.events.find((e) => e.type === "message" && e.phase === "answer");
  if (!err) return [false, "nessun errore per il risponditore bloccato", secs()];
  if (!msg || msg.modelId === "hang" || !msg.text.startsWith("> Risposta di riserva")) return [false, `risposta: ${msg?.modelId} ${msg?.text.slice(0, 40)}`, secs()];
  return [true, `riserva ${msg.modelId} dopo "${err.error}"`, secs()];
};

// Domanda di seguito mentre il dibattito o un turno sono in corso: 409, nessun turno in più.
SCENARIOS.ak = async function ak() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const c = await api("POST", "/api/debates", { body: { question: QUESTION("conv-409"), models: ["slow", "ok-a"], rounds: 0, judge: "ok-a", claudeModel: "sonnet" } });
  if (c.status !== 201) return [false, `POST /api/debates → ${c.status}`, secs()];
  const id = c.body.id;
  const body = { question: FQ("conv-409", "E poi?"), responder: "ok-a", claudeModel: "sonnet" };
  const a = await api("POST", followupPath(id), { body });
  if (a.status !== 409) return [false, `durante il dibattito → ${a.status}`, secs()];
  const d = await followEvents(id, 60_000);
  if (doneEvent(d.events)?.status !== "done") return [false, "dibattito di partenza non concluso", secs()];
  await finalState(id);
  const t1 = await api("POST", followupPath(id), { body: { ...body, responder: "slow" } });
  if (t1.status !== 201) return [false, `primo turno → ${t1.status}`, secs()];
  const b = await api("POST", followupPath(id), { body });
  const b2 = await api("POST", followupPath(id), { body: { ...body, mode: "council", models: ["ok-a", "ok-b"], rounds: 0, judge: "ok-a" } });
  if (b.status !== 409 || b2.status !== 409) return [false, `durante il turno → ${b.status}/${b2.status}`, secs()];
  const e = await followEvents(id, 60_000);
  const st = await finalState(id);
  if (doneEvent(e.events)?.status !== "done" || st.status !== "done") return [false, `turno lento: ${st.status}`, secs()];
  // Cinque richieste insieme: un solo turno nuovo, le altre 409.
  // Risponditore lento: il turno resta in corso mentre arrivano le altre.
  const many = await Promise.all(Array.from({ length: 5 }, () => api("POST", followupPath(id), { body: { ...body, responder: "slow" } })));
  const codes = many.map((x) => x.status).sort().join(",");
  if (codes !== "201,409,409,409,409") return [false, `richieste concorrenti → ${codes}`, secs()];
  await followEvents(id, 30_000);
  const st2 = await finalState(id);
  const users = st2.messages.filter((m) => m.model_id === "_user").length;
  if (users !== 2) return [false, `${users} domande di seguito salvate (attese 2)`, secs()];
  return [true, "409 durante dibattito e turno (quick e council); 5 richieste insieme → 1 turno", secs()];
};

SCENARIOS.al = async function al() {
  const started = Date.now();
  const r = await api("POST", followupPath(987654321), { body: { question: FQ("conv-404", "x"), claudeModel: "sonnet" } });
  const secs = (Date.now() - started) / 1000;
  if (r.status !== 404) return [false, `id inesistente → ${r.status}`, secs];
  return [true, "id inesistente → 404", secs];
};

// Richieste non valide: 400/413/415, mai 500, nessun turno creato. Turno 0 senza risposte: 400.
SCENARIOS.am = async function am() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const r = await baseDebate("conv-bad");
  const base = { question: FQ("conv-bad", "E poi?"), claudeModel: "sonnet" };
  const a = (text, extra = {}) => ({ name: "a.txt", kind: "text", text, ...extra });
  const council = { mode: "council", models: ["ok-a", "ok-b"], rounds: 1, judge: "ok-a" };
  const cases = [
    ["mode sconosciuto", { mode: "fast" }, 400],
    ["mode numero", { mode: 1 }, 400],
    ["domanda vuota", { question: "   " }, 400],
    ["domanda di 20.001 caratteri", { question: "x".repeat(20_001) }, 400],
    ["responder inesistente", { responder: "nessuno" }, 400],
    ["responder numero", { responder: 42 }, 400],
    ["claudeModel sbagliato", { claudeModel: "gpt" }, 400],
    ["council con 1 modello", { ...council, models: ["ok-a"] }, 400],
    ["council models stringa", { ...council, models: "ok-a" }, 400],
    ["council 11 modelli", { ...council, models: MODELS.slice(0, 11) }, 400],
    ["council rounds 5", { ...council, rounds: 5 }, 400],
    ["council giudice inesistente", { ...council, judge: "nessuno" }, 400],
    ["webSearch stringa", { webSearch: "yes" }, 400],
    ["6 allegati", { attachments: Array(6).fill(a("x")) }, 400],
    ["allegato di 40.001 caratteri", { attachments: [a("x".repeat(40_001))] }, 400],
    ["kind sconosciuto", { attachments: [a("x", { kind: "exe" })] }, 400],
    ["corpo > 1.000.000 caratteri", { attachments: [a("x".repeat(1_010_000))] }, 413],
  ];
  const wrong = [];
  for (const [name, extra, want] of cases) {
    const x = await api("POST", followupPath(r.id), { body: { ...base, ...extra } }).catch((e) => ({ status: `errore ${e.message}` }));
    if (x.status !== want) wrong.push(`${name}: atteso ${want}, avuto ${x.status}`);
  }
  const raw = [["corpo elenco", "[]", 400], ["JSON rotto", "{", 400], ["corpo null", "null", 400]];
  for (const [name, body, want] of raw) {
    const x = await api("POST", followupPath(r.id), { body, raw: true });
    if (x.status !== want) wrong.push(`${name}: atteso ${want}, avuto ${x.status}`);
  }
  const ct = await api("POST", followupPath(r.id), { body: base, headers: { "Content-Type": "text/plain" } });
  if (ct.status !== 415) wrong.push(`text/plain → ${ct.status}`);
  // Dibattito fallito senza nessuna risposta: non c'è niente da continuare.
  const f = await debate("conv-bad-empty", ["crash500", "empty"], 0, "ok-a", 60_000);
  if (f.state?.status !== "failed") wrong.push(`dibattito vuoto: stato ${f.state?.status}`);
  const fx = await api("POST", followupPath(f.id), { body: base });
  if (fx.status !== 400) wrong.push(`turno 0 senza risposte → ${fx.status}`);
  for (const id of [r.id, f.id]) {
    const st = (await api("GET", `/api/debates/${id}`)).body;
    if (st?.messages?.some((m) => m.turn > 0)) wrong.push(`dibattito ${id}: turno creato da una richiesta non valida`);
    if (st?.status === "running") wrong.push(`dibattito ${id} rimasto running`);
  }
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs()];
  return [true, `${cases.length + raw.length + 2} richieste non valide respinte (400/413/415), nessun turno creato`, secs()];
};

// Turno "council": fasi complete marcate turn 1, verdetto del turno nel done, verdetto e titolo della
// discussione invariati; contesto completo in initial/verdict, richiamo breve nei round. Poi un turno
// rapido vede il verdetto del consiglio del turno 1.
SCENARIOS.an = async function an() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const r = await baseDebate("conv-council");
  const NEWQ = FQ("conv-council", "E per Napoli?");
  const t = await turnOf(r.id, { question: NEWQ, mode: "council", models: ["ok-a", "ok-b"], rounds: 1, judge: "ok-b" }, 120_000);
  if (t.post.status !== 201 || t.turn !== 1) return [false, `POST followups → ${t.post.status} ${t.post.text.slice(0, 100)}`, secs()];
  const wrong = [];
  if (t.events[0]?.type !== "turn" || t.events[0].mode !== "council") wrong.push("primo evento non turn/council");
  if (t.events.some((e) => e.turn !== 1)) wrong.push("eventi senza turn: 1");
  const start = t.events.find((e) => e.type === "start");
  if (start?.participants?.length !== 2) wrong.push("evento start mancante");
  for (const ph of ["initial", "critique", "verdict"]) if (phaseEvent(t.events, ph) < 0) wrong.push(`fase ${ph} mancante`);
  const done = doneEvent(t.events);
  if (done?.status !== "done" || !done.verdict || "title" in done) wrong.push(`done ${JSON.stringify(done)?.slice(0, 80)}`);
  if (t.state?.verdict !== r.state.verdict || t.state?.title !== r.state.title) wrong.push("verdetto o titolo del turno 0 cambiati");
  const m1 = turnMsgs(t.state, 1);
  for (const [id, ph] of [["ok-a", "initial"], ["ok-b", "initial"], ["ok-a", "critique"], ["judge:ok-b", "verdict"]]) {
    if (!m1.some((m) => m.model_id === id && m.phase === ph && m.content)) wrong.push(`${id}/${ph} non nel turno 1`);
  }
  const pr = (await promptsOf("conv-council")).filter((p) => p.user.includes(NEWQ));
  const by = (ph) => pr.filter((p) => p.phase === ph);
  if (!by("initial").length || by("initial").some((p) => !p.user.includes("CONVERSAZIONE FINORA") || !p.user.includes(r.state.verdict.slice(0, 200)))) wrong.push("initial senza conversazione");
  if (!by("critique").length || by("critique").some((p) => p.user.includes("CONVERSAZIONE FINORA") || !p.user.includes("CONTESTO: domanda successiva"))) wrong.push("critique senza richiamo breve");
  if (!by("verdict").length || by("verdict").some((p) => !p.user.includes("CONVERSAZIONE FINORA") || p.user.includes("TITOLO:"))) wrong.push("verdetto del turno senza conversazione o con TITOLO");
  const t2 = await turnOf(r.id, { question: FQ("conv-council", "Riassumi"), responder: "ok-a" }, 60_000);
  if (t2.turn !== 2 || t2.state?.status !== "done") wrong.push(`turno 2: ${t2.post.status} ${t2.state?.status}`);
  const q2 = (await promptsOf("conv-council")).find((p) => p.phase === "answer");
  if (!q2?.user.includes("### Verdetto del consiglio 1") || !q2.user.includes(done?.verdict?.slice(0, 100) ?? "∅")) wrong.push("il turno rapido non vede il verdetto del turno 1");
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs()];
  return [true, "turno council completo (turn 1, verdetto nel done), contesto giusto per fase, turno 2 lo vede", secs()];
};

// Annullamento durante un turno; chi si ricollega a /events riceve solo il turno in corso; poi un turno
// nuovo è ammesso.
SCENARIOS.ao = async function ao() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const r = await baseDebate("conv-cancel");
  const t1 = await turnOf(r.id, { question: FQ("conv-cancel", "Primo seguito"), responder: "ok-a" }, 60_000);
  if (t1.state?.status !== "done") return [false, `turno 1: ${t1.state?.status}`, secs()];
  const p = await api("POST", followupPath(r.id), { body: { question: FQ("conv-cancel", "Secondo seguito"), responder: "hang", claudeModel: "sonnet" } });
  if (p.status !== 201 || p.body.turn !== 2) return [false, `turno 2 → ${p.status} ${p.text.slice(0, 60)}`, secs()];
  await new Promise((res) => setTimeout(res, 800));
  const follow = followEvents(r.id, 20_000);
  await new Promise((res) => setTimeout(res, 700));
  const live = (await api("GET", `/api/debates/${r.id}`)).body;
  if (live?.status !== "running" || !live.live) return [false, `durante il turno: ${live?.status}, live ${live?.live}`, secs()];
  const tCancel = Date.now();
  const c = await api("POST", `/api/debates/${r.id}/cancel`, { body: {} });
  if (c.status !== 200) return [false, `cancel → ${c.status}`, secs()];
  const ev = await follow;
  const after = (Date.now() - tCancel) / 1000;
  const st = await finalState(r.id);
  const wrong = [];
  if (ev.events[0]?.type !== "turn" || ev.events[0].turn !== 2) wrong.push(`ricollegato: primo evento ${JSON.stringify(ev.events[0])?.slice(0, 60)}`);
  if (ev.events.some((e) => e.turn !== 2)) wrong.push("eventi di un altro turno nel flusso");
  if (doneEvent(ev.events)?.status !== "cancelled") wrong.push(`done ${doneEvent(ev.events)?.status}`);
  if (after > 3) wrong.push(`annullato dopo ${after.toFixed(1)} s`);
  if (st.status !== "cancelled") wrong.push(`stato ${st.status}`);
  if (st.verdict !== r.state.verdict) wrong.push("verdetto cambiato");
  if (turnMsgs(st, 2).some((m) => m.error && m.model_id === "hang")) wrong.push("annullamento registrato come errore");
  const t3 = await turnOf(r.id, { question: FQ("conv-cancel", "Terzo seguito"), responder: "ok-a" }, 60_000);
  if (t3.turn !== 3 || t3.state?.status !== "done") wrong.push(`turno dopo l'annullamento: ${t3.post.status} turno ${t3.turn} ${t3.state?.status}`);
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs()];
  return [true, `cancelled ${after.toFixed(1)} s dopo la richiesta, flusso solo del turno 2, turno 3 ammesso`, secs()];
};

// Dieci turni: nel prompt del decimo solo gli ultimi 6 scambi hanno la risposta, i più vecchi solo la domanda.
SCENARIOS.ap = async function ap() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const r = await baseDebate("conv-many");
  const q = (k) => FQ("conv-many", `Q-${String(k).padStart(2, "0")} come cambia?`);
  for (let k = 1; k <= 10; k++) {
    const t = await turnOf(r.id, { question: q(k), responder: k % 2 ? "ok-a" : "ok-b" }, 60_000);
    if (t.turn !== k || t.state?.status !== "done") return [false, `turno ${k}: ${t.post.status} turno ${t.turn} ${t.state?.status}`, secs()];
  }
  const last = (await promptsOf("conv-many")).find((p) => p.phase === "answer" && p.user.includes(`NUOVA DOMANDA:\n${q(10)}`));
  if (!last) return [false, "prompt del turno 10 non trovato", secs()];
  const u = last.user;
  const wrong = [];
  if (!u.includes(QUESTION("conv-many")) || !u.includes(r.state.verdict.slice(0, 200))) wrong.push("domanda originale o verdetto mancanti");
  for (let k = 1; k <= 9; k++) {
    if (!u.includes(q(k))) wrong.push(`domanda ${k} mancante`);
    const eco = u.includes(`ECO[${q(k)}]`);
    if (k >= 4 && !eco) wrong.push(`risposta ${k} mancante`);
    if (k < 4 && eco) wrong.push(`risposta ${k} presente (doveva restare solo la domanda)`);
  }
  const st = (await api("GET", `/api/debates/${r.id}`)).body;
  const turns = st.messages.map((m) => m.turn ?? 0);
  if (turns.some((x, i) => i && x < turns[i - 1])) wrong.push("messaggi non ordinati per turno");
  if (st.messages.filter((m) => m.model_id === "_user").length !== 10) wrong.push("domande di seguito salvate ≠ 10");
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs()];
  return [true, `10 turni; nel decimo prompt ${u.length} caratteri, risposte solo per i turni 4–9`, secs()];
};

// Eliminazione della discussione durante un turno: il flusso si chiude, nessuna riga orfana.
SCENARIOS.aq = async function aq() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const r = await baseDebate("conv-del");
  const p = await api("POST", followupPath(r.id), { body: { question: FQ("conv-del", "E poi?"), responder: "hang", claudeModel: "sonnet",
    attachments: [{ name: "x.txt", kind: "text", text: "testo da eliminare" }] } });
  if (p.status !== 201) return [false, `POST followups → ${p.status}`, secs()];
  const follow = followEvents(r.id, 10_000);
  await new Promise((res) => setTimeout(res, 1000));
  const d = await api("DELETE", `/api/debates/${r.id}`);
  if (d.status !== 200) return [false, `DELETE → ${d.status}`, secs()];
  const ev = await follow;
  if (ev.timedOut) return [false, "flusso ancora aperto 10 s dopo l'eliminazione", secs()];
  await new Promise((res) => setTimeout(res, 500));
  const g = await api("GET", `/api/debates/${r.id}`);
  const db = new DatabaseSync(join(dataDir, "data", "council.db"), { readOnly: true });
  const orphans = db.prepare("SELECT (SELECT COUNT(*) FROM messages WHERE debate_id = ?) + (SELECT COUNT(*) FROM attachments WHERE debate_id = ?) AS n").get(r.id, r.id).n;
  db.close();
  if (g.status !== 404) return [false, `GET dopo l'eliminazione → ${g.status}`, secs()];
  if (orphans) return [false, `${orphans} righe orfane`, secs()];
  const again = await api("POST", followupPath(r.id), { body: { question: FQ("conv-del", "x"), claudeModel: "sonnet" } });
  if (again.status !== 404) return [false, `domanda di seguito dopo l'eliminazione → ${again.status}`, secs()];
  return [true, `eliminata durante il turno: flusso chiuso (${doneEvent(ev.events)?.status ?? "senza done"}), nessuna riga orfana`, secs()];
};

// Motore ucciso durante un turno: al riavvio la discussione è interrupted, poi un turno nuovo è ammesso.
SCENARIOS.ar = async function ar() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const dir = await mkdtemp(join(tmpdir(), "council-chaos-turn-"));
  extraDirs.push(dir);
  const cfgPath = join(dir, "models.json");
  const mem = (id, model) => ({ id, label: id, kind: "openai", provider: "chaos", model, family: id, default: false });
  await writeFile(cfgPath, JSON.stringify({
    providers: { chaos: { name: "Chaos", baseUrl: `http://127.0.0.1:${mockPort}/v1`, keyEnv: "CHAOS_KEY" } },
    judge: { id: "j", label: "Giudice", kind: "openai", provider: "chaos", model: "ok-a" },
    models: [mem("oka", "ok-a"), mem("okb", "ok-b"), mem("bloccato", "hang")],
  }));
  const boot = async () => {
    const tok = randomBytes(32).toString("hex");
    const e = await startProcess(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.ts"],
      cleanEnv({ COUNCIL_DATA: dir, COUNCIL_MODELS: cfgPath }), "COUNCIL_PORT", JSON.stringify({ token: tok, keys: { CHAOS_KEY } }));
    extraProcs.push(e.proc);
    e.proc.removeAllListeners("exit");
    e.proc.on("exit", (code) => { e.proc.exited = code ?? "signal"; });
    return { ...e, h: authed(tok) };
  };
  const waitState = async (e, id) => {
    let st;
    for (let i = 0; i < 100; i++) {
      st = (await api("GET", `/api/debates/${id}`, { port: e.port, headers: e.h })).body;
      if (st?.status && st.status !== "running") break;
      await new Promise((res) => setTimeout(res, 300));
    }
    return st;
  };
  const e1 = await boot();
  const c = await api("POST", "/api/debates", { port: e1.port, headers: e1.h,
    body: { question: QUESTION("conv-restart"), models: ["oka", "okb"], rounds: 0, judge: "oka", claudeModel: "sonnet" } });
  if (c.status !== 201) return [false, `POST /api/debates → ${c.status}`, secs()];
  const id = c.body.id;
  if ((await waitState(e1, id))?.status !== "done") return [false, "dibattito di partenza non concluso", secs()];
  const f1 = await api("POST", followupPath(id), { port: e1.port, headers: e1.h, body: { question: FQ("conv-restart", "E poi?"), responder: "bloccato", claudeModel: "sonnet" } });
  if (f1.status !== 201) return [false, `turno 1 → ${f1.status}`, secs()];
  await new Promise((res) => setTimeout(res, 1000));
  const before = (await api("GET", `/api/debates/${id}`, { port: e1.port, headers: e1.h })).body;
  if (before?.status !== "running") return [false, `prima del crash stato "${before?.status}"`, secs()];
  const gone = new Promise((res) => e1.proc.once("exit", res));
  e1.proc.kill("SIGKILL");
  await gone;
  const e2 = await boot();
  const d = (await api("GET", `/api/debates/${id}`, { port: e2.port, headers: e2.h })).body;
  const wrong = [];
  if (d?.status !== "interrupted" || d.live) wrong.push(`dopo il riavvio: ${d?.status}, live ${d?.live}`);
  if (d?.verdict == null) wrong.push("verdetto del turno 0 perso");
  const ev = await api("GET", `/api/debates/${id}/events`, { port: e2.port, headers: e2.h });
  if (ev.status !== 404) wrong.push(`eventi → ${ev.status}`);
  const f2 = await api("POST", followupPath(id), { port: e2.port, headers: e2.h, body: { question: FQ("conv-restart", "Riprendiamo"), responder: "oka", claudeModel: "sonnet" } });
  if (f2.status !== 201 || f2.body.turn !== 2) wrong.push(`turno dopo il riavvio → ${f2.status} ${f2.text.slice(0, 60)}`);
  else {
    const st = await waitState(e2, id);
    if (st?.status !== "done" || !turnMsgs(st, 2).some((m) => m.phase === "answer" && m.content)) wrong.push(`turno 2: ${st?.status}`);
  }
  e2.proc.kill("SIGTERM");
  if (wrong.length) return [false, wrong.join("; "), secs()];
  return [true, "SIGKILL durante il turno → interrupted, non live, eventi 404; turno 2 ammesso e concluso", secs()];
};

// La ricerca nella cronologia trova le domande di seguito (senza maiuscole né accenti) e la lista
// restituisce updated_at aggiornato dal turno.
SCENARIOS.as = async function as() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const r = await baseDebate("conv-search");
  const t = await turnOf(r.id, { question: FQ("conv-search", "E passando da Zanzibàr-7781?"), responder: "ok-a" }, 60_000);
  if (t.state?.status !== "done") return [false, `turno: ${t.post.status} ${t.state?.status}`, secs()];
  const l = (await api("GET", "/api/debates?q=ZANZIBAR-7781")).body ?? [];
  const row = l.find((x) => x.id === r.id);
  if (!row) return [false, `domanda di seguito non trovata (${l.length} risultati)`, secs()];
  if (l.length !== 1) return [false, `${l.length} risultati per un termine unico`, secs()];
  if (!row.updated_at || row.updated_at < row.created_at) return [false, `updated_at ${row.updated_at} (created_at ${row.created_at})`, secs()];
  const all = (await api("GET", "/api/debates")).body ?? [];
  const sorted = all.every((x, i) => !i || all[i - 1].updated_at > x.updated_at || (all[i - 1].updated_at === x.updated_at && all[i - 1].id > x.id));
  if (!sorted) return [false, "lista non ordinata per ultima attività", secs()];
  return [true, "trovata con \"ZANZIBAR-7781\" (domanda di seguito con accento), updated_at presente, lista per ultima attività", secs()];
};


// Dibattito annullato durante il giudice (risposte sì, verdetto no): il seguito è ammesso e il contesto
// porta le ultime posizioni dei membri al posto del verdetto.
SCENARIOS.at = async function at() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  let id;
  const p = debate("conv-noverdict", ["ok-a", "ok-b"], 0, "hang", 30_000, { onStart: (x) => (id = x) });
  // Si annulla solo quando l'id è arrivato: sul runner della CI la risposta del POST può tardare
  // oltre un'attesa fissa e l'annullamento andava a /api/debates/undefined/cancel.
  for (let i = 0; i < 100 && id === undefined; i++) await new Promise((res) => setTimeout(res, 100));
  await new Promise((res) => setTimeout(res, 1500));
  await api("POST", `/api/debates/${id}/cancel`, { body: {} });
  const r = await p;
  if (r.state?.status !== "cancelled" || r.state.verdict) return [false, `partenza: ${r.state?.status}, verdetto ${!!r.state?.verdict}`, secs()];
  const t = await turnOf(id, { question: FQ("conv-noverdict", "Allora?"), responder: "ok-a" }, 60_000);
  if (t.post.status !== 201 || t.state?.status !== "done") return [false, `seguito → ${t.post.status} ${t.state?.status}`, secs()];
  const u = (await promptsOf("conv-noverdict")).find((x) => x.phase === "answer")?.user ?? "";
  if (!u.includes("non ha emesso un verdetto") || !u.includes("### Posizione 2")) return [false, "contesto senza le posizioni dei membri", secs()];
  if (t.state.verdict) return [false, "il turno ha scritto il verdetto della discussione", secs()];
  return [true, "turno 0 annullato senza verdetto: seguito ammesso, contesto con le 2 posizioni", secs()];
};

// Turno lungo oltre i 60 s di pulizia del turno precedente: la voce in corso non deve sparire
// (live, /events e annullamento funzionano ancora).
SCENARIOS.au = async function au() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const r = await baseDebate("conv-timer");
  const p = await api("POST", followupPath(r.id), { body: { question: FQ("conv-timer", "E poi?"), responder: "drip", claudeModel: "sonnet" } });
  if (p.status !== 201) return [false, `POST followups → ${p.status}`, secs()];
  await new Promise((res) => setTimeout(res, 63_000));
  const st = (await api("GET", `/api/debates/${r.id}`)).body;
  if (!st?.live) return [false, `dopo 63 s: stato ${st?.status}, live ${st?.live} (voce del turno tolta dal timer del turno 0)`, secs()];
  const follow = followEvents(r.id, 10_000);
  await new Promise((res) => setTimeout(res, 300));
  await api("POST", `/api/debates/${r.id}/cancel`, { body: {} });
  const ev = await follow;
  if (ev.events[0]?.type !== "turn" || doneEvent(ev.events)?.status !== "cancelled") return [false, `flusso: ${ev.events.map((e) => e.type).join(",")}`, secs()];
  return [true, "dopo 63 s il turno è ancora live, flusso e annullamento funzionano", secs()];
};

// Ricerca sul web in una risposta rapida: fase research prima di answer, ricercatore con il richiamo
// alla domanda originale, dossier dopo la nuova domanda; nel turno dopo è nella conversazione.
SCENARIOS.av = async function av() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const r = await baseDebate("conv-web");
  const t = await turnOf(r.id, { question: FQ("conv-web", "Prezzi aggiornati?"), responder: "ok-a", webSearch: true }, 60_000);
  if (t.state?.status !== "done") return [false, `turno 1: ${t.post.status} ${t.state?.status}`, secs()];
  const wrong = [];
  const iR = phaseEvent(t.events, "research"), iA = phaseEvent(t.events, "answer");
  if (iR < 0 || iA < 0 || iR > iA) wrong.push(`fasi research ${iR}, answer ${iA}`);
  if (!turnMsgs(t.state, 1).some((m) => m.phase === "research" && m.content)) wrong.push("dossier non salvato nel turno 1");
  const pr = await promptsOf("conv-web");
  const res = pr.find((x) => x.phase === "research");
  if (!res?.user.includes("Domanda successiva in una discussione partita da")) wrong.push("ricercatore senza richiamo alla domanda originale");
  const a1 = pr.find((x) => x.phase === "answer");
  if (!a1 || a1.user.indexOf(DOSSIER_MARK) < a1.user.indexOf("NUOVA DOMANDA")) wrong.push("dossier assente dal prompt del turno");
  const t2 = await turnOf(r.id, { question: FQ("conv-web", "E quindi?"), responder: "ok-b" }, 60_000);
  const a2 = (await promptsOf("conv-web")).filter((x) => x.phase === "answer").at(-1);
  if (t2.state?.status !== "done" || !a2?.user.includes("Risultati della ricerca sul web") || a2.user.indexOf(DOSSIER_MARK) > a2.user.indexOf("NUOVA DOMANDA")) wrong.push("dossier del turno 1 non nella conversazione del turno 2");
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs()];
  return [true, "ricerca nel turno: research → answer, dossier nel prompt e nella conversazione dopo", secs()];
};

const DESCR = {
  y: "riavvio con dibattito running → interrupted", z: "SSE vivo durante il giudice lento",
  r: "corpo spezzato e corpi non-oggetto", s: "eliminazione a dibattito in corso", t: "SSE: ricollegamento a metà",
  u: "riga del titolo", v: "giudice con verdetto vuoto",
  w: "chiavi dall'app: provider, Claude CLI, log", x: "hello con chiavi ostili",
  p: "chiavi e token mai visibili", q: "permessi dei file dati",
  n: "voce resta sulla riserva", o: "limite token in uscita (OTPM)",
  m: "voce di famiglia: riserva se il principale si blocca",
  a: "ok-a + ok-b, 3 round", b: "ok-a + ok-b + hang, 2 round", lag: "ritardatario fermato nel round", b2: "un solo modello rimasto", c: "flaky-critique rientra", d: "ratelimit con attesa",
  e: "giudice hang → riserva", f: "html non alterato", g: "empty/crash500/gone esclusi", h: "huge 300k caratteri",
  i: "annullamento", j: "input non validi", l: "quota + length (extra)", k: "motore vivo alla fine",
  aa: "ricerca sul web via Groq finto", ab: "ricerca senza ricercatore disponibile", ac: "ricercatore bloccato",
  ad: "allegati nei prompt (e non negli approfondimenti)", ae: "allegati e webSearch non validi",
  af: "allegati al limite + Groq TPM", ag: "annullamento durante la ricerca",
  ah: "ricerca con Claude (CLI finta): strumenti e isolamento",
  ai: "chat: risposta rapida con il contesto giusto", aj: "chat: risponditore bloccato → riserva",
  ak: "chat: seguito durante dibattito/turno → 409", al: "chat: seguito su id inesistente → 404",
  am: "chat: richieste di seguito non valide", an: "chat: turno council completo",
  ao: "chat: annullamento e ricollegamento durante un turno", ap: "chat: 10 turni, contesto troncato",
  aq: "chat: eliminazione durante un turno", ar: "chat: riavvio durante un turno → interrupted",
  as: "chat: ricerca trova le domande di seguito",
  at: "chat: seguito senza verdetto (posizioni)", au: "chat: turno oltre il timer di pulizia",
  av: "chat: ricerca sul web in un turno",
  ax: "riga AFFIDABILITÀ (unità)", ay: "confidenza salvata, restituita e nel prompt del giudice",
  az: "giudice senza riga e tempi medi",
  ba: "sintesi del dibattito dopo il verdetto",
  bb: "ruoli assegnabili nel round di critica",
  bc: "immagini vere alle voci Gemini, testo OCR alle altre",
  bd: "limite di token al minuto, 400 non legati alle immagini, id organizzazione nascosti",
};

// ---------- immagini allegate (solo Gemini) ----------

// Con imageData la voce di famiglia gemini riceve l'immagine vera (data URL nel body), le altre solo il testo
// OCR; vale per partecipante, giudice e domanda di seguito; imageData non esce mai dall'API né dai log; 400 del
// provider con immagini → si riprova una volta senza; input ostili → 400.
SCENARIOS.bd = async function bd() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const { chatOpenAI, imagesFor, outputRoomFrom } = await import("../../src/adapters/openai-compat.ts");
  const { redact } = await import("../../src/redact.ts");
  process.env.CHAOS_UNIT_KEY = "chiave-di-prova";
  const p = { name: "Chaos", baseUrl: `http://127.0.0.1:${mockPort}/v1`, keyEnv: "CHAOS_UNIT_KEY" };
  const wrong = [];
  const user = QUESTION("bd-unit");
  // 1. 429 sui token in uscita con margine: si riprova subito con meno token, senza aspettare i 20 s.
  const t0 = Date.now();
  try {
    const r = await chatOpenAI(p, ["otpm-used"], { system: "s", user, maxTokens: 4096 });
    if (!r.text) wrong.push("otpm: risposta vuota");
    if (Date.now() - t0 > 5000) wrong.push(`otpm: ha aspettato ${Date.now() - t0} ms`);
  } catch (e) { wrong.push(`otpm: ${e.message.slice(0, 120)}`); }
  if (outputRoomFrom("output tokens per minute (OTPM): Limit 1000, Used 900, Requested 800") !== 0) wrong.push("margine sotto 300 accettato");
  if (outputRoomFrom("tokens per minute (TPM): Limit 6000, Used 5800, Requested 900") !== 0) wrong.push("TPM scambiato per OTPM");
  // 2. 400 non legato alle immagini: la voce fallisce ma le immagini non vengono disattivate per sempre.
  try { await chatOpenAI(p, ["gemini-badkey"], { system: "s", user, images: ["/9j/AAAA"] }); wrong.push("badkey: nessun errore"); }
  catch (e) { if (!/API key not valid/.test(e.message)) wrong.push(`badkey: ${e.message.slice(0, 80)}`); }
  if (!imagesFor("gemini-badkey", ["x"]).length) wrong.push("badkey: immagini disattivate per un 400 sulla chiave");
  // 3. Rifiuto vero delle immagini: ricordato solo dopo che il solo testo è passato.
  try { await chatOpenAI(p, ["gemini-noimg"], { system: "s", user, images: ["/9j/AAAA"] }); }
  catch (e) { wrong.push(`noimg: ${e.message.slice(0, 80)}`); }
  if (imagesFor("gemini-noimg", ["x"]).length) wrong.push("noimg: rifiuto non ricordato");
  // 4. Id dell'organizzazione e pubblicità del piano a pagamento fuori dagli errori.
  const red = redact("in organization `org_01abcdefghijklmnop` service tier");
  if (red.includes("org_01abcdef")) wrong.push("id organizzazione non nascosto");
  return [wrong.length === 0, wrong.join("; ") || "margine OTPM usato, immagini disattivate solo se davvero rifiutate, org nascosto", secs()];
};

SCENARIOS.bc = async function bc() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const B64 = "/9j/" + "QUJD".repeat(600) + "==";
  // Due motori: le voci della stessa famiglia si fondono, quindi una sola voce gemini per configurazione.
  const boot = async (gemModel) => {
    const cfg = {
      providers: {
        chaos: { name: "Chaos", baseUrl: `http://127.0.0.1:${mockPort}/v1`, keyEnv: "CHAOS_KEY" },
        qgroq: { name: "Groq finto", baseUrl: `http://127.0.0.1:${mockPort}/qwen/v1`, keyEnv: "CHAOS_KEY" },
      },
      judge: { id: "j", label: "Giudice", kind: "openai", provider: "chaos", model: "ok-a" },
      models: [
        { id: "gem", label: "Gemini", kind: "openai", provider: "chaos", model: gemModel, family: "gemini", default: false },
        { id: "ok", label: "Altro", kind: "openai", provider: "chaos", model: "ok-a", family: "ok-a", default: false },
        { id: "qw", label: "Qwen", kind: "openai", provider: "qgroq", model: QWEN_VISION, family: "qwen", default: false },
      ],
    };
    const tok = randomBytes(32).toString("hex");
    const eng = await startExtraEngine(cfg, JSON.stringify({ token: tok, keys: { CHAOS_KEY } }));
    // Il controllo d'avvio dei modelli deve essere finito prima del primo dibattito.
    for (let i = 0; i < 50; i++) {
      const ms = (await api("GET", "/api/models", { port: eng.port, headers: authed(tok) })).body?.models ?? [];
      if (["gem", "ok", "qw"].every((id) => ms.find((m) => m.id === id)?.available)) break;
      await new Promise((res) => setTimeout(res, 300));
    }
    return { eng, call: (method, path, body) => api(method, path, { port: eng.port, headers: authed(tok), body }) };
  };
  const { eng: e, call } = await boot(GEMINI_MODELS[0]);
  const { eng: e2, call: call2 } = await boot(GEMINI_MODELS[1]);
  const waitDone = async (id, c = call) => {
    for (let i = 0; i < 200; i++) {
      const r = await c("GET", `/api/debates/${id}`);
      if (r.body?.status && r.body.status !== "running") return r.body;
      await new Promise((res) => setTimeout(res, 300));
    }
    return null;
  };
  const wrong = [];
  try {
    const img = { name: "foto.png", kind: "image", text: "OCR-IMG-TESTO", imageData: B64 };
    // 1. Partecipanti e giudice.
    const q = (tag) => QUESTION(tag);
    const c = await call("POST", "/api/debates", { question: q("conv-img-a"), models: ["gem", "ok", "qw"], rounds: 0, judge: "gem", claudeModel: "sonnet", attachments: [img] });
    if (c.status !== 201) return [false, `POST → ${c.status} ${c.text.slice(0, 100)}`, secs()];
    const st = await waitDone(c.body.id);
    if (st?.status !== "done") return [false, `stato "${st?.status}"`, secs()];
    const pr = await promptsOf("conv-img-a");
    const of = (model, phase) => pr.filter((p) => p.model === model && p.phase === phase);
    const g = of(GEMINI_MODELS[0], "initial")[0], o = of("ok-a", "initial")[0], gj = of(GEMINI_MODELS[0], "verdict")[0];
    if (g?.images !== 1 || !g.imageUrls[0].startsWith("data:image/jpeg;base64,")) wrong.push(`gemini initial: ${g?.images} immagini`);
    if (!g?.user.includes("Le immagini allegate sono unite")) wrong.push("gemini senza la riga sulle immagini");
    if (!g?.user.includes("OCR-IMG-TESTO")) wrong.push("gemini senza il testo OCR");
    if (o?.images !== 0 || o.user.includes("Le immagini allegate") || !o.user.includes("OCR-IMG-TESTO")) wrong.push(`non-gemini: ${o?.images} immagini, testo ${o?.user.includes("OCR-IMG-TESTO")}`);
    if (gj?.images !== 1) wrong.push(`giudice gemini: ${gj?.images} immagini`);
    // Qwen 3.8 27B (Groq) riceve l'immagine passando da adapters/index.ts, non solo dall'adapter.
    const qw = of(QWEN_VISION, "initial")[0];
    if (qw?.images !== 1) wrong.push(`qwen initial: ${qw?.images} immagini`);
    // 2. imageData mai restituita.
    const whole = JSON.stringify([st, (await call("GET", "/api/debates")).body, (await call("GET", `/api/debates/${c.body.id}`)).text]);
    if (whole.includes(B64.slice(0, 40)) || whole.includes("imageData")) wrong.push("imageData restituita dall'API");
    const meta = JSON.parse(st.messages.find((m) => m.model_id === "_attachments")?.content ?? "[]");
    if (Object.keys(meta[0] ?? {}).sort().join() !== "chars,kind,name") wrong.push(`metadati ${JSON.stringify(meta[0])}`);
    // 3. Domanda di seguito rapida: la voce gemini riceve ancora l'immagine, l'altra no.
    const t1 = await call("POST", `/api/debates/${c.body.id}/followups`, { question: FQ("conv-img-a", "E poi?"), mode: "quick", responder: "gem", claudeModel: "sonnet" });
    if (t1.status !== 201) wrong.push(`seguito → ${t1.status}`);
    else {
      await waitDone(c.body.id);
      const a1 = (await promptsOf("conv-img-a")).filter((p) => p.phase === "answer" && p.model === GEMINI_MODELS[0]).at(-1);
      if (a1?.images !== 1) wrong.push(`seguito gemini: ${a1?.images} immagini`);
    }
    const t2 = await call("POST", `/api/debates/${c.body.id}/followups`, { question: FQ("conv-img-a", "E ancora?"), mode: "quick", responder: "ok", claudeModel: "sonnet" });
    if (t2.status !== 201) wrong.push(`seguito 2 → ${t2.status}`);
    else {
      await waitDone(c.body.id);
      const a2 = (await promptsOf("conv-img-a")).filter((p) => p.phase === "answer" && p.model === "ok-a").at(-1);
      if (a2?.images !== 0) wrong.push(`seguito non-gemini: ${a2?.images} immagini`);
    }
    // 4. 400 del provider con le immagini: una volta senza.
    const c2 = await call2("POST", "/api/debates", { question: q("conv-img-retry"), models: ["gem", "ok"], rounds: 0, judge: "ok", claudeModel: "sonnet", attachments: [img] });
    const st2 = c2.status === 201 ? await waitDone(c2.body.id, call2) : null;
    const rp = (await promptsOf("conv-img-retry")).filter((p) => p.model === GEMINI_MODELS[1]);
    if (st2?.status !== "done") wrong.push(`retry: stato ${st2?.status ?? c2.status}`);
    else {
      if (rp.map((p) => p.images).join() !== "1,0") wrong.push(`retry: immagini per tentativo ${rp.map((p) => p.images).join()}`);
      if (!okMsgs(st2, "gem", "initial").length) wrong.push("retry: la voce non ha risposto");
    }
    // 5. Input ostili.
    const base = { question: q("conv-img-bad"), models: ["gem", "ok"], rounds: 0, judge: "ok", claudeModel: "sonnet" };
    const big = (n) => "A".repeat(n);
    const cases = [
      ["imageData su kind text", [{ name: "a.txt", kind: "text", text: "x", imageData: "QUJD" }]],
      ["imageData su kind pdf", [{ name: "a.pdf", kind: "pdf", text: "x", imageData: "QUJD" }]],
      ["base64 non valido", [{ ...img, imageData: "***non-base64***" }]],
      ["con prefisso data:", [{ ...img, imageData: "data:image/jpeg;base64,QUJD" }]],
      ["stringa vuota", [{ ...img, imageData: "" }]],
      ["non stringa (numero)", [{ ...img, imageData: 42 }]],
      ["non stringa (elenco)", [{ ...img, imageData: ["QUJD"] }]],
      ["null", [{ ...img, imageData: null }]],
      ["250.001 caratteri", [{ ...img, imageData: big(250_001) }]],
      ["totale 750.000 caratteri", [1, 2, 3].map((n) => ({ ...img, name: `i${n}.png`, imageData: big(250_000) }))],
    ];
    for (const [label, attachments] of cases) {
      const r = await call("POST", "/api/debates", { ...base, attachments });
      if (r.status !== 400) wrong.push(`${label} → ${r.status}`);
    }
    const ok250 = await call("POST", "/api/debates", { ...base, attachments: [{ ...img, imageData: big(250_000) }, { ...img, name: "b.png", imageData: big(250_000) }] });
    if (ok250.status !== 201) wrong.push(`2 immagini da 250.000 → ${ok250.status}`);
    else await waitDone(ok250.body.id);
    // 6. Nessun base64 in log né in cronologia.
    const logs = [...e.proc.log, ...e2.proc.log].join("\n");
    if (logs.includes(B64.slice(0, 60))) wrong.push("base64 nel log del motore");
    const hist = JSON.stringify([st2, (await call2("GET", `/api/debates/${c2.body?.id}`)).body]);
    if (hist.includes(B64.slice(0, 60))) wrong.push("base64 in cronologia");
    // 7. Cancellata con la discussione.
    await call("DELETE", `/api/debates/${c.body.id}`);
    const db = new DatabaseSync(join(e.dir, "data", "council.db"), { readOnly: true });
    const left = db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE debate_id = ?").get(c.body.id).n;
    db.close();
    if (left !== 0) wrong.push(`${left} allegati rimasti dopo l'eliminazione`);
  } finally {
    e.proc.kill("SIGTERM");
    e2.proc.kill("SIGTERM");
  }
  if (wrong.length) return [false, wrong.join("; "), secs()];
  return [true, "immagine solo a Gemini (partecipante, giudice, seguito), mai nell'API né nei log, retry senza immagini, input ostili 400, eliminata col dibattito", secs()];
};

// ---------- ruoli assegnabili ----------

// Verificatore su ok-a: solo il suo prompt lo contiene, l'avvocato casuale tocca l'altro (ok-b); ruolo
// sconosciuto → 400; id che non partecipa → ignorato; senza ruoli resta l'avvocato casuale (uno solo).
SCENARIOS.bb = async function bb() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const wrong = [];
  const crit = async (tag) => (await promptsOf(tag)).filter((x) => x.phase === "critique");
  const r1 = await debate("conv-roles-checker", ["ok-a", "ok-b"], 1, "ok-a", 60_000, { extra: { roles: { "ok-a": "checker", "altro-id": "devil" } } });
  const bad = expectDone(r1, 60);
  if (bad) return [false, bad, secs()];
  const c1 = await crit("conv-roles-checker");
  if (c1.length !== 2) wrong.push(`${c1.length} prompt di critica invece di 2`);
  if (c1.filter((x) => x.user.includes("VERIFICATORE DI FATTI")).length !== 1) wrong.push("verificatore non su un solo prompt");
  const d1 = c1.filter((x) => x.user.includes("AVVOCATO DEL DIAVOLO"));
  if (d1.length !== 1 || d1[0].user.includes("VERIFICATORE DI FATTI")) wrong.push("avvocato casuale: deve essere uno, e non il verificatore");
  const r2 = await debate("conv-roles-none", ["ok-a", "ok-b"], 1, "ok-a", 60_000);
  const bad2 = expectDone(r2, 60);
  if (bad2) return [false, bad2, secs()];
  const c2 = await crit("conv-roles-none");
  if (c2.filter((x) => x.user.includes("AVVOCATO DEL DIAVOLO")).length !== 1) wrong.push("senza ruoli: avvocato casuale non unico");
  for (const roles of [{ "ok-a": "boss" }, "devil", ["devil"]]) {
    const r = await api("POST", "/api/debates", { body: { question: QUESTION("conv-roles-bad"), models: ["ok-a", "ok-b"], rounds: 1, judge: "ok-a", claudeModel: "sonnet", roles } });
    if (r.status !== 400) wrong.push(`roles ${JSON.stringify(roles)} → ${r.status}, atteso 400`);
  }
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs()];
  return [true, "ruolo applicato a un solo prompt, avvocato casuale solo tra chi non ha un ruolo, validazione 400", secs()];
};

// ---------- verdetto breve: riga AFFIDABILITÀ e tempi medi ----------

// splitConfidence (unità): riga assente, tradotta, con markdown, prima o dopo TITOLO, valori tradotti.
SCENARIOS.ax = async function ax() {
  const { splitConfidence, splitTitle } = await import("../../src/debate/prompts.ts");
  const cases = [
    ["AFFIDABILITÀ: alta\n## Risposta\nTesto", "alta", "## Risposta\nTesto"],
    ["Nessuna riga.\n## Risposta\nTesto", null, "Nessuna riga.\n## Risposta\nTesto"],
    ["RELIABILITY: High\nTesto", "alta", "Testo"],
    ["**CONFIDENCE:** medium\nTesto", "media", "Testo"],
    ["**CONFIDENCE**: Low\nTesto", "bassa", "Testo"],
    ["## FIABILIDAD: Baja\nTesto", "bassa", "Testo"],
    ["> AFFIDABILITÀ: **Media**\nTesto", "media", "Testo"],
    ["FIABILITÉ: élevée\nTesto", "alta", "Testo"],
    ["AFFIDABILITA: BASSA\nTesto", "bassa", "Testo"],
    ["AFFIDABILITÀ: boh\nTesto", null, "Testo"],
    ["AFFIDABILITÀ:\n## Risposta\nTesto", null, "## Risposta\nTesto"],
    ["## Affidabilità\nalta, perché…", null, "## Affidabilità\nalta, perché…"],
    [`${"x".repeat(500)}\nAFFIDABILITÀ: alta\nTesto`, null, `${"x".repeat(500)}\nAFFIDABILITÀ: alta\nTesto`],
  ];
  const wrong = cases.filter(([input, conf, verdict]) => {
    const r = splitConfidence(input);
    return r.confidence !== conf || r.verdict !== verdict;
  }).map(([input]) => JSON.stringify(input.slice(0, 30)));
  // Insieme al titolo, in entrambi gli ordini.
  for (const input of ["TITOLO: Treno\nAFFIDABILITÀ: media\n## Risposta\nTesto", "AFFIDABILITÀ: media\nTITOLO: Treno\n## Risposta\nTesto"]) {
    const t = splitTitle(input);
    const c = splitConfidence(t.verdict);
    if (t.title !== "Treno" || c.confidence !== "media" || c.verdict !== "## Risposta\nTesto") wrong.push(`titolo+affidabilità ${JSON.stringify(input.slice(0, 20))}`);
  }
  if (wrong.length) return [false, `casi sbagliati: ${wrong.slice(0, 4).join(", ")}`, 0];
  return [true, `${cases.length + 2} casi di affidabilità corretti`, 0];
};

// Confidenza: salvata e restituita in done, GET, lista e messaggio del verdetto; nel turno council sul
// messaggio del verdetto del turno (la discussione resta invariata); il prompt del giudice ha le risposte iniziali.
SCENARIOS.ay = async function ay() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const r = await debate("conv-conf", ["ok-a", "ok-b"], 1, "ok-a", 60_000);
  const bad = expectDone(r, 60);
  if (bad) return [false, bad, secs()];
  const wrong = [];
  const done = doneEvent(r.events);
  if (done?.confidence !== "alta") wrong.push(`done.confidence ${JSON.stringify(done?.confidence)}`);
  if (r.state?.confidence !== "alta") wrong.push(`GET confidence ${JSON.stringify(r.state?.confidence)}`);
  if (/AFFIDABILIT/.test(r.state?.verdict ?? "") || /AFFIDABILIT/.test(done?.verdict ?? "")) wrong.push("la riga è rimasta nel verdetto");
  const vm = (r.state?.messages ?? []).find((m) => m.phase === "verdict" && m.content);
  if (vm?.confidence !== "alta") wrong.push("confidence non nel messaggio del verdetto");
  const list = (await api("GET", "/api/debates")).body;
  if (list?.find?.((d) => d.id === r.id)?.confidence !== "alta") wrong.push("confidence non nella lista");
  const jp = (await promptsOf("conv-conf")).find((p) => p.phase === "verdict");
  if (!jp?.user.includes("RISPOSTE INIZIALI") || !jp.user.includes("del modello ok-a") || !jp.user.includes("del modello ok-b")) wrong.push("prompt del giudice senza risposte iniziali");
  if (!jp?.user.includes("AFFIDABILITÀ: alta | media | bassa") || !jp.user.includes("## Dove divergono")) wrong.push("prompt del giudice senza la nuova struttura");
  const t = await turnOf(r.id, { question: FQ("conv-conf", "E per Napoli?"), mode: "council", models: ["ok-a", "ok-b"], rounds: 0, judge: "ok-b" }, 120_000);
  if (t.state?.status !== "done") return [false, `turno council: ${t.post.status} ${t.state?.status}`, secs()];
  if (doneEvent(t.events)?.confidence !== "alta") wrong.push("done del turno senza confidence");
  if (turnMsgs(t.state, 1).find((m) => m.phase === "verdict" && m.content)?.confidence !== "alta") wrong.push("confidence non nel verdetto del turno");
  if (t.state?.confidence !== "alta" || t.state?.verdict !== r.state.verdict) wrong.push("discussione cambiata dal turno");
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs()];
  return [true, "confidenza in done, GET, lista, messaggio e turno council; giudice con risposte iniziali", secs()];
};

// Giudice senza riga (null, nessun errore) o con riga tradotta/in grassetto; avgMs null senza dati e
// valorizzato dopo un dibattito.
SCENARIOS.az = async function az() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const m0 = (await api("GET", "/api/models")).body;
  const never = m0?.models?.find((m) => m.id === "badkey");
  if (!never || !("avgMs" in never) || never.avgMs !== null) return [false, `avgMs di un modello senza risposte: ${JSON.stringify(never?.avgMs)}`, secs()];
  const n = await baseDebate("conv-noconf");
  const c = await baseDebate("conv-confmd");
  const wrong = [];
  const dn = doneEvent(n.events);
  if (dn?.status !== "done" || !("confidence" in dn) || dn.confidence !== null) wrong.push(`senza riga: ${JSON.stringify(dn?.confidence)}`);
  if (n.state?.confidence !== null || !n.state?.verdict) wrong.push("senza riga: GET");
  if (doneEvent(c.events)?.confidence !== "alta" || c.state?.confidence !== "alta" || /CONFIDENCE/.test(c.state?.verdict ?? "")) wrong.push("riga tradotta in grassetto");
  const m1 = (await api("GET", "/api/models")).body;
  const ok = m1?.models?.find((m) => m.id === "ok-a");
  if (typeof ok?.avgMs !== "number" || ok.avgMs < 0) wrong.push(`avgMs ok-a ${JSON.stringify(ok?.avgMs)}`);
  if (typeof m1?.judgeAvgMs !== "number") wrong.push(`judgeAvgMs ${JSON.stringify(m1?.judgeAvgMs)}`);
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs()];
  return [true, "riga assente → null senza errori, riga tradotta letta, avgMs null/valorizzato, judgeAvgMs", secs()];
};

// Sintesi del dibattito: il giudice la scrive prima della riga VERDETTO; si salva dopo il verdetto,
// oltre il separatore. Senza riga (o con una parte vuota) il testo resta tutto verdetto.
SCENARIOS.ba = async function ba() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const { splitDebate, DEBATE_MARKER: M } = await import("../../src/debate/prompts.ts");
  const cases = [
    ["## Su cosa\n- x\n\nVERDETTO\n\n## Risposta\nTesto", `## Risposta\nTesto\n\n${M}\n\n## Su cosa\n- x`],
    ["## Agreement\n- x\n**VERDICT:**\n## Answer\nText", `## Answer\nText\n\n${M}\n\n## Agreement\n- x`],
    ["## Su cosa\n- x\n## VERDETTO\n## Risposta\nTesto", `## Risposta\nTesto\n\n${M}\n\n## Su cosa\n- x`],
    ["## Risposta\nTesto senza riga", "## Risposta\nTesto senza riga"],
    ["VERDETTO\n## Risposta\nTesto", "## Risposta\nTesto"],
    ["## Su cosa\n- x\nVERDETTO\n", "## Su cosa\n- x\nVERDETTO\n"],
    ["## Risposta\nIl verdetto è chiaro.\nVerdetto finale: sì", "## Risposta\nIl verdetto è chiaro.\nVerdetto finale: sì"],
  ];
  const wrong = cases.filter(([input, out]) => splitDebate(input) !== out).map(([input]) => JSON.stringify(input.slice(0, 30)));
  const r = await debate("conv-sintesi", ["ok-a", "ok-b"], 0, "ok-a", 60_000);
  const bad = expectDone(r, 60);
  if (bad) return [false, bad, secs()];
  const v = r.state?.verdict ?? "";
  if (!v.startsWith("**Risposta di prova**") || !v.includes(`${M}\n\n## Su cosa concordano`) || /^VERDETTO$/m.test(v)) wrong.push("verdetto salvato senza sintesi dopo il separatore");
  if (doneEvent(r.events)?.verdict !== v) wrong.push("done diverso dal GET");
  const n = await debate("conv-nodebate", ["ok-a", "ok-b"], 0, "ok-a", 60_000);
  if (n.state?.status !== "done" || (n.state?.verdict ?? "").includes(M)) wrong.push("giudice senza sintesi: separatore aggiunto");
  const jp = (await promptsOf("conv-sintesi")).find((p) => p.phase === "verdict");
  if (!jp?.user.includes("## Errori emersi nel dibattito") || !jp.user.includes("la sola parola VERDETTO")) wrong.push("prompt del giudice senza le sezioni sul dibattito");
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs()];
  return [true, `${cases.length} casi di separazione corretti; sintesi salvata dopo il verdetto`, secs()];
};

// ---------- provider: famiglie senza modelli gratuiti, immagini a Qwen (gruppo providers) ----------

DESCR.be = "voce di una famiglia rimasta senza modelli gratuiti (DeepSeek su OpenRouter)";
DESCR.bf = "immagini vere a Qwen 3.8 27B: massimo 3, riprova senza se la richiesta è troppo grande";

/** Server finto locale per uno scenario: `onChat(model, images, user, body)` → [stato, corpo]. */
async function miniProvider(models, onChat) {
  const { createServer } = await import("node:http");
  const srv = createServer(async (req, res) => {
    let s = "";
    for await (const c of req) s += c;
    const reply = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url.endsWith("/models")) return reply(200, { data: models });
    let body = {};
    try { body = JSON.parse(s || "{}"); } catch { /* corpo non JSON */ }
    const uc = body.messages?.find((m) => m.role === "user")?.content;
    const parts = Array.isArray(uc) ? uc : [];
    const images = parts.filter((p) => p?.type === "image_url").map((p) => String(p.image_url?.url ?? ""));
    const user = Array.isArray(uc) ? parts.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : String(uc ?? "");
    const [status, out] = onChat(String(body.model ?? ""), images, user, body);
    reply(status, typeof out === "string"
      ? { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: out } }] }
      : out);
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { srv, url: `http://127.0.0.1:${srv.address().port}/api/v1` };
}

// Il catalogo ":free" di OpenRouter non ha più DeepSeek: la voce salvata dall'utente (anche con un modello
// fisso ritirato) resta nella selezione, il controllo d'avvio la segna "down" spiegando perché, il motore
// non chiama mai i DeepSeek a pagamento e un dibattito che la include finisce con un errore leggibile.
SCENARIOS.be = async function be() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const { readFile } = await import("node:fs/promises");
  const NEMO = "nvidia/nemotron-3.5-super-vl:free";
  const price = (p) => ({ prompt: p, completion: p });
  const chatCalls = [];
  const { srv, url } = await miniProvider([
    { id: "deepseek/deepseek-v4", name: "DeepSeek V4", pricing: price("0.0000003") },
    { id: "deepseek/deepseek-r2", name: "DeepSeek R2", pricing: price("0.000001") },
    { id: NEMO, name: "Nemotron 3.5 Super VL (free)", pricing: price("0") },
  ], (model, _img, user) => {
    if (user.trim() !== "Scrivi solo: OK") chatCalls.push(model);
    if (!model.startsWith("nvidia/")) return [402, { error: { message: "Insufficient credits" } }];
    return [200, user.includes("POSIZIONI FINALI") || /giudice|verdetto/i.test(user) ? "TITOLO: Prova\nAFFIDABILITÀ: media\n\n**Risposta di prova**" : "Risposta di prova di Nemotron."];
  });
  const dir = await mkdtemp(join(tmpdir(), "council-chaos-be-"));
  extraDirs.push(dir);
  const voice = (id, label, family, model, def = true) => ({ id, label, kind: "openai", provider: "openrouter", family, model, default: def });
  await writeFile(join(dir, "models.json"), JSON.stringify({
    providers: { openrouter: { name: "OpenRouter finto", baseUrl: url, keyEnv: "CHAOS_KEY" } },
    judge: { id: "giudice", label: "Giudice", kind: "openai", provider: "openrouter", model: NEMO },
    models: [voice("nemotron", "Nemotron", "nemotron", "auto")],
  }));
  // Selezione salvata da una versione vecchia: DeepSeek con un modello fisso ":free" che non esiste più.
  await writeFile(join(dir, "selection.json"), JSON.stringify({ auto: true, models: [
    { id: "deepseek", label: "DeepSeek V3", kind: "openai", provider: "openrouter", model: "deepseek/deepseek-chat-v3-0324:free", default: true },
    voice("nemotron", "Nemotron", "nemotron", "auto"),
  ] }));
  const tok = randomBytes(32).toString("hex");
  const env = cleanEnv({ COUNCIL_DATA: dir });
  delete env.COUNCIL_MODELS; // la selezione salvata vale solo senza configurazione alternativa
  const e = await startProcess(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.ts"], env, "COUNCIL_PORT",
    JSON.stringify({ token: tok, keys: { CHAOS_KEY } }));
  extraProcs.push(e.proc);
  e.proc.removeAllListeners("exit");
  e.proc.on("exit", (code) => { e.proc.exited = code ?? "signal"; });
  const call = (method, path, body) => api(method, path, { port: e.port, headers: authed(tok), body });
  const wrong = [];
  try {
    let ms = null;
    for (let i = 0; i < 60; i++) {
      const r = await call("GET", "/api/models");
      if (r.status === 200 && !r.body.checking && r.body.models.every((m) => m.health?.status !== "checking" && m.health?.status !== "unchecked")) { ms = r.body.models; break; }
      await new Promise((res) => setTimeout(res, 300));
    }
    if (!ms) return [false, "controllo d'avvio non concluso", secs()];
    const ds = ms.find((m) => m.id === "deepseek"), nm = ms.find((m) => m.id === "nemotron");
    if (!ds) wrong.push("voce DeepSeek sparita dalla selezione");
    else {
      if (ds.health?.status !== "down") wrong.push(`DeepSeek: stato ${ds.health?.status}`);
      if (!/non ha più modelli gratuiti/.test(ds.health?.note ?? "")) wrong.push(`DeepSeek: nota "${ds.health?.note}"`);
    }
    if (nm?.health?.status !== "ok" || nm.health.using !== NEMO) wrong.push(`Nemotron: ${nm?.health?.status} ${nm?.health?.using}`);
    const saved = JSON.parse(await readFile(join(dir, "selection.json"), "utf8")).models.find((m) => m.id === "deepseek");
    if (saved?.family !== "deepseek" || saved.model !== "auto" || !saved.default) wrong.push(`selection.json: ${JSON.stringify(saved)?.slice(0, 120)}`);
    // Dibattito con la voce senza modelli: deve finire, con la voce in errore e l'altra che risponde.
    const c = await call("POST", "/api/debates", { question: QUESTION("be-deepseek"), models: ["deepseek", "nemotron"], rounds: 0, judge: "nemotron", claudeModel: "sonnet" });
    if (c.status !== 201) wrong.push(`POST → ${c.status} ${c.text.slice(0, 80)}`);
    else {
      let st = null;
      for (let i = 0; i < 100; i++) {
        const r = await call("GET", `/api/debates/${c.body.id}`);
        if (r.body?.status && r.body.status !== "running") { st = r.body; break; }
        await new Promise((res) => setTimeout(res, 300));
      }
      if (st?.status !== "done") wrong.push(`dibattito: ${st?.status ?? "non concluso"}`);
      else {
        const dErr = (st.messages ?? []).find((m) => m.model_id === "deepseek" && m.error);
        if (!dErr || !/nessun modello/.test(dErr.content ?? dErr.error ?? "")) wrong.push(`errore DeepSeek: ${JSON.stringify(dErr)?.slice(0, 120)}`);
        if (!okMsgs(st, "nemotron", "initial").length) wrong.push("Nemotron non ha risposto");
      }
    }
    if (chatCalls.some((m) => m.startsWith("deepseek/"))) wrong.push(`chiamato un DeepSeek a pagamento: ${chatCalls.filter((m) => m.startsWith("deepseek/")).slice(0, 2)}`);
    if (e.proc.exitCode !== null || e.proc.exited !== undefined) wrong.push("motore terminato");
  } finally {
    srv.close();
    srv.closeAllConnections?.();
  }
  return [wrong.length === 0, wrong.slice(0, 4).join("; ") || "voce salvata intatta, down con spiegazione, nessuna chiamata a pagamento, dibattito concluso", secs()];
};

// Qwen 3.8 27B su Groq accetta immagini: al massimo 3 per richiesta (la nota lo dice al modello); se il
// piano gratuito rifiuta la richiesta per dimensione si riprova col solo testo senza spegnere le immagini;
// "reduce max_tokens" abbassa l'uscita e tiene le immagini; i base64 non compaiono negli errori.
SCENARIOS.bf = async function bf() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const { chatOpenAI, imagesFor } = await import("../../src/adapters/openai-compat.ts");
  const QWEN = "qwen/qwen3.8-27b";
  const B64 = "/9j/" + "QkZC".repeat(600) + "==";
  const seen = []; // [tag, immagini, max_tokens]
  const { srv, url } = await miniProvider([], (model, images, user, body) => {
    const tag = user.match(/\[bf:(\w+)\]/)?.[1] ?? "?";
    seen.push([tag, images.length, body.max_tokens]);
    if (images.length > 3) return [400, { error: { message: "Too many images: at most 3 per request" } }];
    if (tag === "big" && images.length) return [413, { error: { message: `Request too large for model \`${model}\` on tokens per minute (TPM): Limit 8000, Requested 9500` } }];
    if (tag === "always") return [413, { error: { message: `Request too large: ${images[0] ?? "data:image/jpeg;base64," + B64}` } }];
    if (tag === "otpm" && body.max_tokens > 800) return [429, { error: { message: "Request too large: expected output tokens exceed the limit, reduce max_tokens. Limit 1000" } }];
    return [200, `ok ${images.length}`];
  });
  process.env.CHAOS_BF_KEY = "chiave-di-prova-bf";
  const p = { name: "Groq finto", baseUrl: url, keyEnv: "CHAOS_BF_KEY" };
  const five = Array.from({ length: 5 }, () => B64);
  const ask = (tag, extra = {}) => chatOpenAI(p, [QWEN], { system: "s", user: `[bf:${tag}] domanda`, images: five, ...extra });
  const of = (tag) => seen.filter((s) => s[0] === tag);
  const wrong = [];
  try {
    // 1. Solo Qwen 3.8 27B (non altri Qwen né Gemma), al massimo 3.
    if (imagesFor(QWEN, five).length !== 3) wrong.push(`Qwen: ${imagesFor(QWEN, five).length} immagini`);
    if (imagesFor("qwen/qwen3-32b", five).length || imagesFor("gemma-4-31b-it", five).length) wrong.push("immagini a un modello che non le accetta");
    if (imagesFor("gemini-3-flash", five).length !== 5) wrong.push("Gemini limitato");
    const r1 = await ask("base");
    if (of("base").map((s) => s[1]).join() !== "3" || r1.text !== "ok 3") wrong.push(`base: ${of("base").map((s) => s[1])}`);
    // 2. Troppo grande con le immagini: un secondo tentativo senza, la voce risponde, le immagini restano attive.
    const r2 = await ask("big");
    if (of("big").map((s) => s[1]).join() !== "3,0" || r2.text !== "ok 0") wrong.push(`big: ${of("big").map((s) => s[1])}`);
    if (imagesFor(QWEN, five).length !== 3) wrong.push("immagini disattivate dopo un errore di dimensione");
    await ask("again");
    if (of("again").map((s) => s[1]).join() !== "3") wrong.push(`dopo big: ${of("again").map((s) => s[1])}`);
    // 3. Errore finale con il base64 nel messaggio: mascherato.
    try { await ask("always"); wrong.push("always: nessun errore"); }
    catch (e) { if (e.message.includes(B64.slice(0, 60))) wrong.push("base64 nell'errore"); }
    // 4. "reduce max_tokens" con le immagini: si abbassa l'uscita, le immagini restano.
    const r4 = await ask("otpm", { maxTokens: 4096 });
    const o = of("otpm");
    if (r4.text !== "ok 3" || o.at(-1)?.[1] !== 3 || !(o.at(-1)?.[2] <= 800)) wrong.push(`otpm: ${JSON.stringify(o)}`);
  } catch (e) {
    wrong.push(`eccezione: ${e.message.slice(0, 120)}`);
  } finally {
    srv.close();
    srv.closeAllConnections?.();
  }
  return [wrong.length === 0, wrong.slice(0, 4).join("; ") || "3 immagini su 5, riprova senza solo per dimensione, max_tokens abbassato con le immagini, base64 mascherato", secs()];
};

// ---------- ruoli visibili e nei turni; immagini nei turni di seguito ----------

// Ruolo nei partecipanti di start e _meta (solo per chi ce l'ha, solo con il round di critica); "Rilancia
// il consiglio" riusa i ruoli della discussione se non passati, accetta quelli nuovi, {} li toglie, 400 sui
// ruoli sconosciuti, id non partecipanti ignorati.
SCENARIOS.bg = async function bg() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const wrong = [];
  const TAG = "conv-rolevis";
  const roleMap = (list) => Object.fromEntries((list ?? []).filter((p) => "role" in p).map((p) => [p.id, p.role]));
  const startOf = (events) => events.find((e) => e.type === "start");
  const metaOf = (state, turn) => {
    try { return JSON.parse(turnMsgs(state, turn).find((m) => m.model_id === "_meta" && m.phase === "start")?.content ?? "[]"); } catch { return []; }
  };
  const lastCrit = async (model) => (await promptsOf(TAG)).filter((p) => p.phase === "critique" && p.model === model).at(-1)?.user ?? "";
  const r = await debate(TAG, ["ok-a", "ok-b"], 1, "ok-a", 60_000, { extra: { roles: { "ok-a": "checker", "non-partecipa": "devil" } } });
  const bad = expectDone(r, 60);
  if (bad) return [false, bad, secs()];
  const want = JSON.stringify({ "ok-a": "checker" });
  if (JSON.stringify(roleMap(startOf(r.events)?.participants)) !== want) wrong.push(`start: ${JSON.stringify(startOf(r.events)?.participants)}`);
  if (JSON.stringify(roleMap(metaOf(r.state, 0))) !== want) wrong.push(`_meta: ${JSON.stringify(metaOf(r.state, 0))}`);
  // Senza round di critica il ruolo non agisce e non si mostra.
  const r0 = await debate("conv-rolevis0", ["ok-a", "ok-b"], 0, "ok-a", 60_000, { extra: { roles: { "ok-a": "devil" } } });
  if (Object.keys(roleMap(startOf(r0.events)?.participants)).length) wrong.push("ruolo mostrato con 0 round");
  const council = { mode: "council", models: ["ok-a", "ok-b"], rounds: 1, judge: "ok-a" };
  // 1. Senza roles: si riusano quelli della discussione.
  const t1 = await turnOf(r.id, { ...council, question: FQ(TAG, "E per il ritorno?") }, 60_000);
  if (t1.post.status !== 201 || t1.state?.status !== "done") return [false, `turno 1 → ${t1.post.status} ${t1.state?.status}`, secs()];
  if (JSON.stringify(roleMap(startOf(t1.events)?.participants)) !== want) wrong.push(`turno 1 start: ${JSON.stringify(startOf(t1.events)?.participants)}`);
  if (JSON.stringify(roleMap(metaOf(t1.state, 1))) !== want) wrong.push("turno 1 _meta senza ruolo");
  if (!(await lastCrit("ok-a")).includes("VERIFICATORE DI FATTI")) wrong.push("turno 1: verificatore non riusato");
  // 2. Ruoli nuovi: sostituiscono quelli della discussione; id non partecipanti ignorati.
  const t2 = await turnOf(r.id, { ...council, question: FQ(TAG, "E in estate?"), roles: { "ok-b": "devil", "altro": "checker" } }, 60_000);
  if (t2.post.status !== 201 || t2.state?.status !== "done") return [false, `turno 2 → ${t2.post.status} ${t2.state?.status}`, secs()];
  if (JSON.stringify(roleMap(startOf(t2.events)?.participants)) !== JSON.stringify({ "ok-b": "devil" })) wrong.push(`turno 2 start: ${JSON.stringify(startOf(t2.events)?.participants)}`);
  if (!(await lastCrit("ok-b")).includes("AVVOCATO DEL DIAVOLO") || (await lastCrit("ok-a")).includes("VERIFICATORE DI FATTI")) wrong.push("turno 2: ruoli nuovi non applicati");
  // 3. Riuso dall'ultimo consiglio rilanciato, non dal dibattito originale.
  const t3 = await turnOf(r.id, { ...council, question: FQ(TAG, "E in inverno?") }, 60_000);
  if (JSON.stringify(roleMap(startOf(t3.events)?.participants)) !== JSON.stringify({ "ok-b": "devil" })) wrong.push("turno 3: non riusa l'ultimo consiglio");
  // 3b. Un rilancio con 0 round (ruoli inattivi, non salvati) non cancella quelli della discussione.
  const t3z = await turnOf(r.id, { ...council, rounds: 0, question: FQ(TAG, "In breve?") }, 60_000);
  if (t3z.state?.status !== "done") wrong.push(`turno a 0 round → ${t3z.state?.status}`);
  const t3b = await turnOf(r.id, { ...council, question: FQ(TAG, "E all'alba?") }, 60_000);
  if (JSON.stringify(roleMap(startOf(t3b.events)?.participants)) !== JSON.stringify({ "ok-b": "devil" })) wrong.push("dopo un turno a 0 round i ruoli si perdono");
  // 4. {} esplicito: nessun ruolo.
  const t4 = await turnOf(r.id, { ...council, question: FQ(TAG, "E di notte?"), roles: {} }, 60_000);
  if (Object.keys(roleMap(startOf(t4.events)?.participants)).length) wrong.push("turno 4: {} non toglie i ruoli");
  // 5. Validazione come POST /api/debates; la discussione resta utilizzabile.
  for (const roles of [{ "ok-a": "boss" }, "devil", ["devil"]]) {
    const p = await api("POST", followupPath(r.id), { body: { ...council, claudeModel: "sonnet", question: FQ(TAG, "x"), roles } });
    if (p.status !== 400) wrong.push(`roles ${JSON.stringify(roles)} → ${p.status}, atteso 400`);
  }
  const after = await api("GET", `/api/debates/${r.id}`);
  if (after.body?.status === "running") wrong.push("discussione bloccata in corso dopo un 400");
  // Risposta rapida: roles ignorati.
  const q = await turnOf(r.id, { question: FQ(TAG, "Riassumi"), responder: "ok-b", roles: { "ok-a": "boss" } }, 60_000);
  if (q.post.status !== 201) wrong.push(`risposta rapida con roles → ${q.post.status}`);
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs()];
  return [true, "role in start/_meta, riuso nei turni, ruoli nuovi, {} vuoto, 400, rapida li ignora", secs()];
};

// Immagini nei turni di seguito: tetto per chiamata (unità) e, dal vivo, solo quelle della domanda iniziale
// più quelle del turno corrente (non quelle dei turni intermedi), con risposta rapida e consiglio rilanciato.
SCENARIOS.bh = async function bh() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const wrong = [];
  const { imagesOf, IMAGES_MAX, IMAGES_MAX_CHARS } = await import("../../src/debate/prompts.ts");
  const im = (c, n) => ({ name: `${c}.jpg`, kind: "image", text: "x", imageData: c.repeat(n) });
  const short = (xs) => xs.map((x) => `${x[0]}${x.length}`).join(",");
  const cases = [
    [[[im("A", 400_000)], [im("B", 300_000)]], "B300000"],
    [[[im("A", 200_000), im("B", 200_000)], [im("C", 100_000)]], "A200000,B200000,C100000"],
    [[[im("A", 500_000), im("B", 50_000)], [im("C", 100_000)]], "B50000,C100000"],
    [[Array.from({ length: 10 }, (_, i) => im("ABCDEFGHIJ"[i], 10))], "CDEFGHIJ".split("").map((c) => `${c}10`).join(",")],
    [[undefined, [{ name: "t", kind: "text", text: "x" }]], ""],
  ];
  for (const [lists, out] of cases) if (short(imagesOf(...lists)) !== out) wrong.push(`imagesOf → ${short(imagesOf(...lists))}, atteso ${out}`);
  if (IMAGES_MAX !== 8 || IMAGES_MAX_CHARS !== 600_000) wrong.push("limiti cambiati");

  const cfg = {
    providers: { chaos: { name: "Chaos", baseUrl: `http://127.0.0.1:${mockPort}/v1`, keyEnv: "CHAOS_KEY" } },
    judge: { id: "j", label: "Giudice", kind: "openai", provider: "chaos", model: "ok-a" },
    models: [
      { id: "gem", label: "Gemini", kind: "openai", provider: "chaos", model: GEMINI_MODELS[0], family: "gemini", default: false },
      { id: "ok", label: "Altro", kind: "openai", provider: "chaos", model: "ok-a", family: "ok-a", default: false },
    ],
  };
  const tok = randomBytes(32).toString("hex");
  const eng = await startExtraEngine(cfg, JSON.stringify({ token: tok, keys: { CHAOS_KEY } }));
  const call = (method, path, body) => api(method, path, { port: eng.port, headers: authed(tok), body });
  const waitDone = async (id) => {
    for (let i = 0; i < 200; i++) {
      const r = await call("GET", `/api/debates/${id}`);
      if (r.body?.status && r.body.status !== "running") return r.body;
      await new Promise((res) => setTimeout(res, 300));
    }
    return null;
  };
  try {
    for (let i = 0; i < 50; i++) {
      const ms = (await call("GET", "/api/models")).body?.models ?? [];
      if (["gem", "ok"].every((id) => ms.find((m) => m.id === id)?.available)) break;
      await new Promise((res) => setTimeout(res, 300));
    }
    const TAG = "conv-img-turns";
    // Prima lettera dopo "/9j/" diversa per ogni immagine: si riconosce nei primi 30 caratteri del data URL.
    const img = (c) => ({ name: `${c}.jpg`, kind: "image", text: `OCR-${c}`, imageData: `/9j/${c.repeat(4 * 300)}` });
    const tagOf = (url) => url.slice("data:image/jpeg;base64,/9j/".length, "data:image/jpeg;base64,/9j/".length + 1);
    const c = await call("POST", "/api/debates", { question: QUESTION(TAG), models: ["gem", "ok"], rounds: 0, judge: "ok", claudeModel: "sonnet", attachments: [img("A")] });
    if (c.status !== 201) return [false, `POST → ${c.status} ${c.text.slice(0, 100)}`, secs()];
    if ((await waitDone(c.body.id))?.status !== "done") return [false, "dibattito di partenza non concluso", secs()];
    const turn = async (body) => {
      const p = await call("POST", `/api/debates/${c.body.id}/followups`, { claudeModel: "sonnet", ...body });
      if (p.status !== 201) { wrong.push(`seguito → ${p.status} ${p.text.slice(0, 80)}`); return; }
      await waitDone(c.body.id);
    };
    const gemLast = async (phase) => (await promptsOf(TAG)).filter((p) => p.model === GEMINI_MODELS[0] && p.phase === phase).at(-1);
    await turn({ question: FQ(TAG, "Primo seguito"), mode: "quick", responder: "ok", attachments: [img("B")] });
    await turn({ question: FQ(TAG, "Secondo seguito"), mode: "quick", responder: "gem", attachments: [img("C")] });
    const a2 = await gemLast("answer");
    if (a2?.imageUrls.map(tagOf).join() !== "A,C") wrong.push(`rapida: immagini ${a2?.imageUrls.map(tagOf).join()} invece di A,C`);
    if (!a2?.user.includes("OCR-B")) wrong.push("rapida: testo OCR del turno intermedio perso");
    await turn({ question: FQ(TAG, "Rilancio"), mode: "council", models: ["gem", "ok"], rounds: 0, judge: "ok" });
    const i3 = await gemLast("initial");
    if (i3?.imageUrls.map(tagOf).join() !== "A") wrong.push(`consiglio: immagini ${i3?.imageUrls.map(tagOf).join()} invece di A`);
  } finally {
    eng.proc.kill("SIGTERM");
  }
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs()];
  return [true, `${cases.length} casi del tetto; nei turni solo immagini della domanda iniziale e del turno corrente`, secs()];
};

DESCR.bg = "ruoli visibili e riusati in Rilancia il consiglio";
DESCR.bh = "immagini nei turni di seguito: iniziali + turno corrente, con tetto";

// Lingua del verdetto dichiarata al giudice per nome (Gemini scriveva in inglese un verdetto su una domanda
// italiana). Unità su detectLanguage + prompt, e dal vivo: il giudice riceve la riga "la domanda è in italiano".
SCENARIOS.bi = async function bi() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const { detectLanguage, judgePrompt } = await import("../../src/debate/prompts.ts");
  const wrong = [];
  const cases = [
    ["miglior fornetto elettrico sui 20 litri multifunzione massimo 90euro venduto su amazon per fare tipo lasagne patate etc", "italiano"],
    ["meglio columbia patagonia o northface", "italiano"],
    ["What is the best laptop for coding under 1000 dollars?", "inglese"],
    ["¿Cuál es el mejor portátil para programar?", "spagnolo"],
    ["Quel est le meilleur ordinateur pour coder ?", "francese"],
    ["Welche ist die beste Kamera für Anfänger?", "tedesco"],
    ["iPhone 17 vs Pixel 10", null],
  ];
  for (const [q, want] of cases) if (detectLanguage(q) !== want) wrong.push(`${q.slice(0, 25)}… → ${detectLanguage(q)}`);
  const last = (q, finals) => judgePrompt(q, finals, []).split("\n").at(-1);
  if (!last(cases[0][0], []).includes("è in italiano")) wrong.push("prompt: italiano non dichiarato");
  if (!last(cases[2][0], []).includes("è in inglese")) wrong.push("prompt: inglese non dichiarato");
  // Domanda di soli nomi: decide la lingua dei membri; senza esito resta la regola generale.
  if (!last("iPhone 17 vs Pixel 10", [{ label: "A", text: "Meglio il Pixel per le foto, ma l'iPhone dura di più ed è più fluido." }]).includes("è in italiano")) wrong.push("ripiego sui membri");
  if (!last("iPhone 17 vs Pixel 10", []).includes("nel dubbio")) wrong.push("regola generale persa");
  if (/tradott|Traduci/.test(judgePrompt(cases[0][0], [], []))) wrong.push("il prompt chiede ancora di tradurre");
  // Dal vivo: il prompt che arriva al giudice.
  const r = await debate("conv-lang", ["ok-a", "ok-b"], 0, "ok-a", 60_000);
  const bad = expectDone(r, 60);
  if (bad) wrong.push(bad);
  else {
    const j = (await promptsOf("conv-lang")).filter((p) => p.phase === "verdict").at(-1);
    if (!j?.user.includes("Lingua: la domanda è in italiano")) wrong.push("dal vivo: lingua non dichiarata al giudice");
  }
  if (wrong.length) return [false, wrong.slice(0, 4).join("; "), secs()];
  return [true, `${cases.length} lingue riconosciute, lingua dichiarata al giudice, ripiego sui membri`, secs()];
};
DESCR.bi = "lingua del verdetto dichiarata al giudice";

// ---------- streaming, codici d'errore, riprova con le immagini (gruppo motore-live) ----------

DESCR.bj = "streaming: pezzi additivi coerenti col messaggio, ricollegamento a metà col testo accumulato";
DESCR.bk = "streaming fermo, interrotto o con errore a metà: testo scartato, codici timeout/interrupted";
DESCR.bl = "streaming: la riserva riparte da capo; Claude CLI in stream-json (finta)";
DESCR.bm = "codici d'errore stabili e casi limite del riprova con le immagini";

/** Testo accumulato dai `delta` di una voce in una fase (`reset` sostituisce). */
function deltaText(events, modelId, phase) {
  let t = "";
  for (const e of events) {
    if (e.type !== "delta" || e.modelId !== modelId || e.phase !== phase) continue;
    t = e.reset ? e.text : t + e.text;
  }
  return t;
}

/** Come followEvents, su un motore qualsiasi (porta e intestazioni). */
function followOn(port, headers, id, timeoutMs) {
  return new Promise((resolve) => {
    const events = [];
    let finished = false;
    const finish = (timedOut) => { if (finished) return; finished = true; clearTimeout(timer); req.destroy(); resolve({ events, timedOut }); };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const req = request({ host: "127.0.0.1", port, path: `/api/debates/${id}/events`, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish(false); }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
          buf = buf.slice(i + 2);
          if (!line) continue;
          try { const e = JSON.parse(line.slice(6)); events.push(e); if (e.type === "done") return finish(false); } catch { /* non JSON */ }
        }
      });
      res.on("end", () => finish(false));
      res.on("error", () => finish(false));
    });
    req.on("error", () => finish(false));
    req.end();
  });
}

// "slow" scrive per 20 s: i pezzi arrivano come `delta` (solo additivi), il loro testo è l'inizio del messaggio
// finale, nessun pezzo dopo il messaggio, eventi esistenti invariati; chi si collega a metà riceve subito tutto il
// testo accumulato (`reset`) e poi i pezzi nuovi. Il verdetto in diretta non mostra le righe macchina.
SCENARIOS.bj = async function bj() {
  let late;
  const res = await debate("bj", ["slow", "ok-a"], 0, "slow", 90_000, {
    onStart: (id) => { late = new Promise((ok) => setTimeout(() => ok(followEvents(id, 60_000)), 8000)); },
  });
  const l = await late;
  const err = expectDone(res, 90);
  if (err) return [false, err, res.secs];
  const wrong = [];
  const msg = res.events.find((e) => e.type === "message" && e.modelId === "slow");
  const acc = deltaText(res.events, "slow", "initial");
  const deltas = res.events.filter((e) => e.type === "delta" && e.modelId === "slow");
  if (deltas.length < 5) wrong.push(`solo ${deltas.length} pezzi da slow`);
  if (!msg || !acc || !msg.text.startsWith(acc.trimEnd()) || acc.length < msg.text.length / 2) wrong.push(`testo dei pezzi (${acc.length}) non è l'inizio del messaggio (${msg?.text.length})`);
  if (deltas.some((e) => e.reset)) wrong.push("reset senza riserve");
  const after = res.events.slice(res.events.indexOf(msg) + 1).some((e) => e.type === "delta" && e.modelId === "slow" && e.phase === "initial");
  if (after) wrong.push("pezzi dopo il messaggio");
  const extra = res.events.filter((e) => e.type === "message").flatMap((e) => Object.keys(e)).filter((k) => !["type", "phase", "modelId", "text", "ms", "model", "replaced", "confidence"].includes(k));
  if (extra.length) wrong.push(`campi nuovi in message: ${[...new Set(extra)]}`);
  const first = l.events.find((e) => e.type === "delta" && e.modelId === "slow");
  if (!first?.reset || !first.text || !msg?.text.startsWith(first.text.trimEnd())) wrong.push(`ricollegamento: primo pezzo ${JSON.stringify(first)?.slice(0, 80)}`);
  const lateAcc = deltaText(l.events, "slow", "initial");
  if (!lateAcc || !msg?.text.startsWith(lateAcc.trimEnd()) || lateAcc.length < acc.length / 2) wrong.push("ricollegamento: testo accumulato incoerente");
  const vd = deltaText(res.events, "judge:slow", "verdict");
  if (!vd) wrong.push("nessun pezzo del verdetto");
  if (/AFFIDABILIT|TITOLO/.test(vd)) wrong.push("righe macchina nel verdetto in diretta");
  if ((res.state?.messages ?? []).some((m) => m.phase === "delta")) wrong.push("pezzi salvati nel DB");
  return [wrong.length === 0, wrong.slice(0, 4).join("; ") || `${deltas.length} pezzi additivi, ricollegamento con ${first.text.length} caratteri accumulati`, res.secs];
};

// Pezzi e poi silenzio (stall), connessione chiusa (cut) o chunk d'errore (error): il testo mostrato si
// scarta (`reset` vuoto), la voce esce con codice timeout (dopo ~20 s senza pezzi) o interrupted.
SCENARIOS.bk = async function bk() {
  const res = await debate("bk", ["stream-stall", "stream-cut", "stream-error", "ok-a"], 0, "ok-a", 90_000);
  const err = expectDone(res, 90);
  if (err) return [false, err, res.secs];
  const wrong = [];
  const want = { "stream-stall": "timeout", "stream-cut": "interrupted", "stream-error": "interrupted" };
  for (const [id, code] of Object.entries(want)) {
    const ev = res.events.find((e) => e.type === "error" && e.modelId === id);
    const row = errMsgs(res.state, id)[0];
    if (ev?.error_code !== code) wrong.push(`${id}: evento ${ev?.error_code} (${ev?.error?.slice(0, 60)})`);
    if (row?.error_code !== code) wrong.push(`${id}: salvato ${row?.error_code}`);
    const ds = res.events.filter((e) => e.type === "delta" && e.modelId === id);
    if (!ds.length) wrong.push(`${id}: nessun pezzo prima dell'errore`);
    else if (deltaText(res.events, id, "initial") !== "") wrong.push(`${id}: testo parziale non scartato`);
  }
  if (res.secs > 45) wrong.push(`troppo lento: ${res.secs.toFixed(0)} s`);
  if (okMsgs(res.state, "ok-a", "initial").length !== 1) wrong.push("ok-a senza risposta");
  return [wrong.length === 0, wrong.slice(0, 4).join("; ") || "stall → timeout, cut/error → interrupted, testo scartato", res.secs];
};

// Voce di famiglia: il principale scrive e poi cade, la riserva riparte da capo (reset vuoto, poi il suo testo
// con `model` = riserva). Claude CLI finta in stream-json: pezzi `text_delta`, testo finale dalla riga `result`.
SCENARIOS.bl = async function bl() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const tok = randomBytes(32).toString("hex");
  const bin = await mkdtemp(join(tmpdir(), "council-chaos-bin-"));
  extraDirs.push(bin);
  const FINAL = "Risposta finale di Claude finta, scritta a pezzi.";
  await writeFile(join(bin, "claude"), `#!${process.execPath}
const a = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", async () => {
  if (!a.includes("stream-json") || !a.includes("--include-partial-messages") || !a.includes("--verbose")) {
    process.stdout.write(JSON.stringify({ result: "SENZA STREAMING" }));
    return;
  }
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "system", subtype: "init" });
  out({ type: "stream_event", event: { type: "message_start", message: {} } });
  for (const w of ${JSON.stringify(FINAL)}.match(/.{1,8}/g)) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w } } });
    await new Promise((r) => setTimeout(r, 60));
  }
  out({ type: "assistant", message: { content: [{ type: "text", text: ${JSON.stringify(FINAL)} }] } });
  out({ type: "result", subtype: "success", is_error: false, result: ${JSON.stringify(FINAL)} });
});
`);
  await chmod(join(bin, "claude"), 0o755);
  const cfg = {
    providers: { chaos: { name: "Chaos", baseUrl: `http://127.0.0.1:${mockPort}/v1`, keyEnv: "CHAOS_KEY" } },
    judge: { id: "j", label: "Giudice", kind: "openai", provider: "chaos", model: "ok-a" },
    models: [
      { id: "fam", label: "Famiglia", kind: "openai", provider: "chaos", model: "stream-cut", fallback: ["ok-b"], family: "fam", default: false },
      { id: "fakeclaude", label: "Finta Claude", kind: "claude-cli", model: "sonnet", default: false },
      { id: "okb", label: "B", kind: "openai", provider: "chaos", model: "ok-b", family: "okb", default: false },
    ],
  };
  const e = await startExtraEngine(cfg, JSON.stringify({ token: tok, keys: { CHAOS_KEY } }), { env: { PATH: `${bin}:${process.env.PATH}` } });
  const c = await api("POST", "/api/debates", { port: e.port, headers: authed(tok),
    body: { question: QUESTION("bl"), models: ["fam", "fakeclaude"], rounds: 0, judge: "okb", claudeModel: "sonnet" } });
  if (c.status !== 201) return [false, `POST /api/debates → ${c.status} ${c.text?.slice(0, 100)}`, secs()];
  const { events, timedOut } = await followOn(e.port, authed(tok), c.body.id, 60_000);
  e.proc.kill("SIGTERM");
  if (timedOut) return [false, "nessun done entro 60 s", secs()];
  const wrong = [];
  const fam = events.filter((x) => x.type === "delta" && x.modelId === "fam" && x.phase === "initial");
  const cut = fam.findIndex((x) => x.reset && x.text === "");
  if (cut < 1) wrong.push(`famiglia: nessun reset vuoto dopo i pezzi del principale (${fam.length} pezzi)`);
  const rest = fam.slice(cut + 1);
  // ok-b risponde in un colpo: il messaggio arriva prima del primo raggruppamento, i pezzi possono mancare.
  if (rest.some((x) => x.model !== "ok-b")) wrong.push(`famiglia: pezzi dopo il reset da ${JSON.stringify(rest.map((x) => x.model))}`);
  const fm = events.find((x) => x.type === "message" && x.modelId === "fam");
  if (fm?.model !== "ok-b" || fm?.replaced !== "stream-cut") wrong.push(`famiglia: messaggio da ${fm?.model} al posto di ${fm?.replaced}`);
  if (!fm?.text.startsWith(deltaText(events, "fam", "initial").trimEnd())) wrong.push("famiglia: pezzi della riserva non sono l'inizio del messaggio");
  const cm = events.find((x) => x.type === "message" && x.modelId === "fakeclaude");
  const cd = events.filter((x) => x.type === "delta" && x.modelId === "fakeclaude");
  if (cm?.text !== FINAL) wrong.push(`claude: messaggio ${JSON.stringify(cm?.text)?.slice(0, 60)}`);
  if (cd.length < 2 || !FINAL.startsWith(deltaText(events, "fakeclaude", "initial"))) wrong.push(`claude: ${cd.length} pezzi`);
  return [wrong.length === 0, wrong.slice(0, 4).join("; ") || `riserva da capo dopo ${cut} pezzi; Claude in ${cd.length} pezzi`, secs()];
};

// Codici d'errore: dal testo (unità) e su eventi e righe salvate (quota, 500, vuota, chiave rifiutata).
// Immagini: Qwen solo sul provider Groq; 400 "reduce max_tokens" non toglie le immagini a Qwen; 413 dovuto al
// solo testo non riprova senza immagini.
SCENARIOS.bm = async function bm() {
  const started = Date.now();
  const secs = () => (Date.now() - started) / 1000;
  const wrong = [];
  const { errorCode } = await import("../../src/errors.ts");
  const table = [
    ["HTTP 429: Rate limit reached for model x on tokens per minute (TPM): Limit 6000. Please try again in 2s", "rate_limited"],
    ["HTTP 429: You exceeded your current quota, please check your plan", "quota_exhausted"],
    ["HTTP 429: Request too large for model x on tokens per minute (TPM): Limit 8000, Requested 9500, please reduce your message size", "too_long"],
    ["HTTP 413: Request too large", "too_long"],
    ["HTTP 400: API key not valid. Please pass a valid API key.", "invalid_key"],
    ["HTTP 401: Incorrect API key provided: ***", "invalid_key"],
    ["chiave GROQ_API_KEY mancante: aggiungila in Impostazioni ▸ Chiavi API", "missing_key"],
    ["HTTP 404: The model `x` does not exist", "model_retired"],
    ["ha saltato questo round (nessuna risposta entro 90 s)", "timeout"],
    ["troppo lento: gli altri avevano finito, nessuna risposta entro 31 s", "timeout"],
    ["risposta interrotta a metà: Upstream error", "interrupted"],
    ["provider non raggiungibile (ECONNREFUSED): fetch failed", "network"],
    ["risposta vuota dal modello", "empty"],
    ["Claude: Claude AI usage limit reached|1700000000", "quota_exhausted"],
    ["claude non avviabile: spawn claude ENOENT", "claude_unavailable"],
    ["HTTP 503: The model is overloaded", "rate_limited"],
    ["HTTP 500: Internal server error", "provider_error"],
    ["Nessun giudice ha prodotto il verdetto.", "no_verdict"],
    ["qualcosa di strano", "unknown"],
  ];
  for (const [m, c] of table) if (errorCode(m) !== c) wrong.push(`"${m.slice(0, 40)}" → ${errorCode(m)} (atteso ${c})`);

  const res = await debate("bm", ["quota", "crash500", "empty", "leaky", "ok-a"], 0, "ok-a", 60_000);
  const want = { quota: "quota_exhausted", crash500: "provider_error", empty: "empty", leaky: "invalid_key" };
  for (const [id, c] of Object.entries(want)) {
    const ev = res.events.find((x) => x.type === "error" && x.modelId === id);
    if (ev?.error_code !== c) wrong.push(`${id}: evento ${ev?.error_code}`);
    if (errMsgs(res.state, id)[0]?.error_code !== c) wrong.push(`${id}: salvato ${errMsgs(res.state, id)[0]?.error_code}`);
  }
  const bad = await debate("bm-fail", ["quota", "crash500"], 0, "quota", 60_000);
  const d = doneEvent(bad.events);
  if (d?.status !== "failed" || d?.error_code !== "no_answer") wrong.push(`done fallito: ${d?.status} ${d?.error_code}`);

  const { chatOpenAI, imagesFor, textAloneTooLarge } = await import("../../src/adapters/openai-compat.ts");
  const QWEN = "qwen/qwen3.8-27b";
  const img = "/9j/" + "QkZC".repeat(100) + "==";
  const imgs = [img, img];
  const groq = { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyEnv: "X" };
  const orouter = { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "X" };
  if (imagesFor(QWEN, imgs, groq).length !== 2) wrong.push("Qwen su Groq senza immagini");
  if (imagesFor(QWEN, imgs, orouter).length) wrong.push("immagini a Qwen su OpenRouter");
  if (imagesFor("gemini-3-flash", imgs, orouter).length !== 2) wrong.push("Gemini limitato a un provider");
  if (!textAloneTooLarge("Limit 8000, Requested 20000", QWEN, 2, groq)) wrong.push("413 del solo testo non riconosciuto");
  if (textAloneTooLarge("Limit 8000, Requested 9500", QWEN, 2, groq)) wrong.push("413 dovuto alle immagini scambiato per testo");

  const seen = [];
  const { srv, url } = await miniProvider([], (model, images, user, body) => {
    const tag = user.match(/\[bm:(\w+)\]/)?.[1] ?? "?";
    seen.push([tag, images.length, body.max_tokens]);
    if (tag === "mt" && body.max_tokens > 800) return [400, { error: { message: "`max_tokens` is too large: reduce max_tokens. Limit 1000", type: "invalid_request_error" } }];
    if (tag === "big") return [413, { error: { message: `Request too large for model \`${model}\` on tokens per minute (TPM): Limit 8000, Requested 30000` } }];
    return [200, `ok ${images.length}`];
  });
  process.env.CHAOS_BM_KEY = "chiave-di-prova-bm";
  const p = { name: "Groq finto", baseUrl: url, keyEnv: "CHAOS_BM_KEY" };
  const of = (tag) => seen.filter((s) => s[0] === tag).map((s) => s[1]).join();
  try {
    const r = await chatOpenAI(p, [QWEN], { system: "s", user: "[bm:mt] domanda", images: imgs, maxTokens: 4096 });
    if (r.text !== "ok 2" || !seen.filter((s) => s[0] === "mt").every((s) => s[1] === 2)) wrong.push(`reduce max_tokens: ${r.text}, immagini ${of("mt")}`);
    if (imagesFor(QWEN, imgs, p).length !== 2) wrong.push("immagini tolte a Qwen dopo un 400 per max_tokens");
    try { await chatOpenAI(p, [QWEN], { system: "s", user: "[bm:big] domanda", images: imgs }); wrong.push("big: nessun errore"); } catch { /* atteso */ }
    if (of("big") !== "2") wrong.push(`413 del solo testo: tentativi con immagini ${of("big")}`);
  } catch (e) {
    wrong.push(`eccezione: ${e.message.slice(0, 120)}`);
  } finally {
    srv.close();
    srv.closeAllConnections?.();
  }
  return [wrong.length === 0, wrong.slice(0, 4).join("; ") || `${table.length} testi classificati, codici su eventi e righe, 3 casi immagini`, secs()];
};

// ---------- main ----------

async function main() {
  const only = process.argv[2]?.split(",").map((s) => s.trim()).filter(Boolean);
  dataDir = await mkdtemp(join(tmpdir(), "council-chaos-"));

  const m = await startProcess(process.execPath, [join(HERE, "mock-provider.mjs"), "0"], { ...process.env }, "MOCK_PORT");
  mock = m.proc; mockPort = m.port;

  const cfgPath = join(dataDir, "models.chaos.json");
  const member = (id) => ({ id, label: `Chaos ${id}`, kind: "openai", provider: "chaos", model: id, family: id, default: false });
  await writeFile(cfgPath, JSON.stringify({
    providers: {
      chaos: { name: "Chaos", baseUrl: `http://127.0.0.1:${mockPort}/v1`, keyEnv: "CHAOS_KEY" },
      chaosbad: { name: "Chaos chiave rovinata", baseUrl: `http://127.0.0.1:${mockPort}/v1`, keyEnv: "CHAOS_BAD_KEY" },
      // "groq" finto: la voce GPT-OSS fa la ricerca sul web (browser_search) negli scenari aa, ac, ag.
      groq: { name: "Groq finto", baseUrl: `http://127.0.0.1:${mockPort}/v1`, keyEnv: "CHAOS_KEY" },
    },
    // Giudice predefinito non Claude: un modello "ritirato", così la catena di riserva passa ai partecipanti.
    judge: { id: "chaos-judge", label: "Chaos giudice predefinito", kind: "openai", provider: "chaos", model: "gone" },
    // Voce di famiglia: il modello principale si blocca, deve rispondere la riserva ok-b.
    models: [...MODELS.map(member), { id: "voce", label: "Voce di famiglia", kind: "openai", provider: "chaos", family: "voce", model: "hang", fallback: ["ok-b"], default: false },
      { id: "badkey", label: "Chiave rovinata", kind: "openai", provider: "chaosbad", model: "ok-a", family: "badkey", default: false },
      { id: "gptoss", label: "GPT-OSS", kind: "openai", provider: "groq", model: "openai/gpt-oss-120b", family: "gpt-oss", default: false }],
  }, null, 2));

  // Avviato come dall'app: token sulla prima riga dello stdin, chiusura con lo stdin.
  // Ricerca sul web con tempo massimo breve (6 s invece di 180 s): scenari ac e ag.
  const env = { ...process.env, COUNCIL_DATA: dataDir, COUNCIL_MODELS: cfgPath, PORT: "0", CHAOS_KEY, CHAOS_BAD_KEY, COUNCIL_PARENT: "app",
    COUNCIL_RESEARCH_TIMEOUT_MS: String(RESEARCH_TIMEOUT_S * 1000) };
  delete env.ANTHROPIC_API_KEY;
  const e = await startProcess(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.ts"], env, "COUNCIL_PORT",
    JSON.stringify({ token: TOKEN }));
  engine = e.proc; enginePort = e.port;
  engine.removeAllListeners("exit");
  engine.on("exit", (code) => { engine.exited = code ?? "signal"; });

  // Attende la fine del controllo d'avvio (le prove ricevono sempre "OK" dal mock).
  for (let i = 0; i < 60; i++) {
    const r = await api("GET", "/api/models");
    if (r.status === 200 && !r.body.checking) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log(`mock :${mockPort}  motore :${enginePort}  dati ${dataDir}\n`);

  const results = [];
  const run = async (k) => {
    try {
      const [pass, why, secs] = await SCENARIOS[k]();
      results.push({ k, pass, why, secs });
    } catch (err) {
      results.push({ k, pass: false, why: `eccezione: ${err.message}`, secs: 0 });
    }
    const x = results[results.length - 1];
    console.log(`${x.pass ? "PASS" : "FAIL"} ${k}. ${DESCR[k]} — ${x.why} (${x.secs.toFixed(1)} s)`);
  };

  const keys = Object.keys(SCENARIOS).filter((k) => !only || only.includes(k));
  if (keys.includes("j")) await run("j");
  await Promise.all(keys.filter((k) => k !== "j").map(run));

  // k. dopo tutto: motore vivo e raggiungibile.
  const r = await api("GET", "/api/models").catch((err) => ({ status: err.message }));
  const alive = engine.exitCode === null && engine.exited === undefined;
  const pass = r.status === 200 && alive;
  results.push({ k: "k", pass, why: `/api/models ${r.status}, processo ${alive ? "vivo" : `terminato (${engine.exited})`}`, secs: 0 });
  console.log(`${pass ? "PASS" : "FAIL"} k. ${DESCR.k} — ${results.at(-1).why}`);
  if (!alive) console.log("Ultime righe del motore:\n" + engine.log.slice(-15).join("\n"));

  const stats = await api("GET", "/stats", { port: mockPort }).catch(() => null);
  if (stats?.body) console.log(`\nchiamate al mock: ${JSON.stringify(stats.body.calls)} (connessioni hang aperte: ${stats.body.hanging})`);

  const failed = results.filter((x) => !x.pass).length;
  console.log(`\n${results.length - failed} passati, ${failed} falliti`);
  return failed;
}

const t0 = Date.now();
main()
  .then(async (failed) => {
    console.log(`tempo totale ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    await cleanup();
    process.exit(failed ? 1 : 0);
  })
  .catch(async (err) => {
    console.error(`Errore della suite: ${err.message}`);
    if (engine?.log) console.error(engine.log.slice(-15).join("\n"));
    await cleanup();
    process.exit(1);
  });
