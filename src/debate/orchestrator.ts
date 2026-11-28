import { config, type ModelDef } from "../config.ts";
import { chat } from "../adapters/index.ts";
import { saveMessage, finishDebate, finishTurn, type MessageRow } from "../db.ts";
import * as P from "./prompts.ts";
import { redact } from "../redact.ts";
import { findResearcher, runResearch, type ResearchSelection } from "./research.ts";
import { CodedError, errorCode, type ErrorCode } from "../errors.ts";

export type Phase = "research" | "initial" | "critique" | "revise" | "final" | "verdict" | "answer";

export type Rounds = 0 | 1 | 2 | 3;

export interface DebateOptions {
  /** 0 = solo risposte indipendenti, 1 = + critica, 2 = + revisione, 3 = + posizione finale. */
  rounds: Rounds;
  /** Giudice scelto (prima scelta della catena). */
  judge: ModelDef;
  /** Modello usato da Claude (kind "claude-cli"), sia come partecipante sia come giudice. */
  claudeModel: string;
  /** Approfondimento di un dibattito concluso. */
  parentContext?: P.ParentContext & { id: number };
  /** Ricerca sul web prima della fase iniziale. */
  webSearch?: boolean;
  /** Ruoli speciali per id di voce (agiscono nel round di critica). */
  roles?: Record<string, P.Role>;
  /** Allegati (testo già estratto dall'app). Non passano agli approfondimenti. */
  attachments?: P.Attachment[];
  /** Turno della chat (0 = dibattito originale). */
  turn?: number;
  /** Turni ≥ 1: conversazione finora (vedi followup.ts). */
  conversation?: P.Conversation;
}

/** Campo `turn` presente solo nei turni ≥ 1 (assente = 0). */
export type DebateEvent = (
  | {
      type: "start";
      debateId: number;
      /** `judge: true` sul partecipante che è anche il giudice scelto (additivo, come in `_meta`). */
      participants: { id: string; label: string; letter: string; role?: P.Role; judge?: true }[];
      rounds: Rounds;
      judge: string;
      /** Il giudice scelto (primo della catena) è anche un partecipante (additivo). */
      judgeParticipated: boolean;
      parentId: number | null;
    }
  | { type: "phase"; phase: Phase; note?: string }
  | { type: "message"; phase: Phase; modelId: string; text: string; ms: number; model?: string; replaced?: string; confidence?: "alta" | "media" | "bassa" | null }
  | { type: "error"; phase: Phase; modelId: string; error: string; error_code?: ErrorCode }
  | { type: "done"; status: "done" | "failed" | "cancelled"; verdict?: string; title?: string; confidence?: "alta" | "media" | "bassa" | null; error?: string; error_code?: ErrorCode }
  /**
   * Streaming (additivo): pezzo di testo del messaggio in corso di `modelId` in `phase`. `reset` = il testo
   * sostituisce quello accumulato (riserva che riparte, "" = tentativo fallito a metà). Il messaggio completo
   * arriva poi con `message` (o `error`), che vince sul testo accumulato. `model`: variante che sta scrivendo.
   */
  | { type: "delta"; phase: Phase; modelId: string; text: string; reset?: true; model?: string }
  | { type: "turn"; question: string; mode: "quick" | "council" }
) & { turn?: number };

interface Debater {
  def: ModelDef;
  letter: string;
  alive: boolean;
  initial?: string;
  critique?: string;
  revised?: string;
  final?: string;
  /** Round saltati (1 critica, 2 revisione, 3 posizione finale): note per il giudice. */
  skipped?: number[];
}

const LETTERS = "ABCDEFGHIJKL";

/** Tetto totale per un intervento (riserve e attese comprese): oltre, il modello salta il round. Con lo
 *  streaming un modello fermo lo ferma prima l'attesa senza pezzi (`STREAM_IDLE_MS`), quindi il tetto
 *  serve solo per chi scrive piano: 90 s dai tempi reali (nov 2026) lasciano finire Nemotron (fino a 57 s)
 *  anche con una riserva dietro. Nella risposta iniziale non c'è la regola del ritardatario: lì si può
 *  attendere fino a 90 s un modello che sta ancora scrivendo (prima: 45 s, senza vedere nulla). */
const PARTICIPANT_BUDGET_MS = testMs("COUNCIL_PARTICIPANT_BUDGET_MS", 90_000);
/**
 * Tetto di sicurezza assoluto per chi ha iniziato a scrivere entro il tetto normale: può finire finché manda
 * pezzi (lo ferma l'attesa senza pezzi), ma non oltre il doppio. 180 s: Nemotron, il più lento dei modelli
 * reali (fino a 57 s a risposta), resta lontano; una risposta che a 90 s scrive ancora ha di solito più o meno
 * la stessa strada davanti; oltre, è un flusso che non finisce (modello in ciclo) e la fase non può restare
 * ferma per lui.
 */
const PARTICIPANT_HARD_MS = 2 * PARTICIPANT_BUDGET_MS;
/** Streaming: nessun pezzo da tanto = tentativo fermo, si passa alla riserva (vedi openai-compat.ts). */
const STREAM_IDLE_MS = testMs("COUNCIL_STREAM_IDLE_MS", 20_000);
/** Giudice e risposta rapida: richieste lunghe (tutto il dibattito o la conversazione), primo pezzo più lento. */
const JUDGE_IDLE_MS = 30_000;
/** Pezzi raggruppati al massimo ogni 50 ms: meno eventi SSE, il ritmo della vista lo decide l'app. */
const DELTA_EVERY_MS = 50;
/** Nei round: quando hanno risposto tutti tranne uno, l'ultimo ha ancora al massimo 15 s, ma mai meno di
 *  30 s dall'inizio del round (la Claude CLI impiega ~24 s anche quando gli altri finiscono in 3). */
const STRAGGLER_GRACE_MS = 15_000;
const STRAGGLER_FLOOR_MS = 30_000;
/** Numero del round per fase, per le note al giudice sui round saltati. */
const ROUND_OF: Record<string, number> = { critique: 1, revise: 2, final: 3 };
/** Tempo di un giudice o di una risposta rapida (abbreviabile solo per le prove). */
const JUDGE_BUDGET_MS = testMs("COUNCIL_JUDGE_BUDGET_MS", 150_000);
/**
 * Giudice e risposta rapida che stanno scrivendo: fino a 240 s, come il tetto della fase del verdetto (che resta
 * il limite vero del giudice) e il tempo massimo della Claude CLI: un tetto più alto non servirebbe a nessuno.
 */
const JUDGE_HARD_MS = 240_000;
/** Tetto della fase del verdetto (tutta la catena) e numero massimo di giudici provati: verdetto entro 4 min
 *  al peggio, invece di 150 s × (partecipanti + 2). Abbreviabile solo per le prove. */
const VERDICT_BUDGET_MS = (() => {
  const t = Number(process.env.COUNCIL_VERDICT_BUDGET_MS);
  return Number.isInteger(t) && t >= 1000 && t < 240_000 ? t : 240_000;
})();
export const JUDGE_CHAIN_MAX = 4;
/** Tempo massimo della ricerca sul web (oltre: errore non fatale). Abbreviabile solo per le prove. */
const RESEARCH_BUDGET_MS = (() => {
  const t = Number(process.env.COUNCIL_RESEARCH_TIMEOUT_MS);
  return Number.isInteger(t) && t >= 1000 && t < 180_000 ? t : 180_000;
})();

/** Tempi abbreviabili solo per le prove (chaos): un valore fuori da 1 s…predefinito resta il predefinito. */
function testMs(name: string, fallback: number): number {
  const t = Number(process.env[name]);
  return Number.isInteger(t) && t >= 1000 && t < fallback ? t : fallback;
}

/** Dove salvare ed emettere: discussione, turno, flusso di eventi, annullamento. */
export interface TurnCtx {
  debateId: number;
  turn: number;
  emit: (e: DebateEvent) => void;
  signal: AbortSignal;
}

/** Salva un messaggio nel turno giusto. */
export function save(ctx: TurnCtx, m: MessageRow): void {
  saveMessage(ctx.debateId, { ...m, turn: ctx.turn });
}

/** Copia del modello con il modello Claude scelto: config non viene modificata. */
export const withClaudeModel = (m: ModelDef, claudeModel: string): ModelDef => (m.kind === "claude-cli" ? { ...m, model: claudeModel } : m);

/** Timer che si ferma e riparte (attesa nella coda del provider). */
function pausableTimer(ms: number, fire: () => void) {
  let left = ms, since = Date.now(), done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { since = Date.now(); timer = setTimeout(() => { timer = undefined; done = true; fire(); }, left); };
  arm();
  return {
    pause(paused: boolean) {
      if (done) return;
      if (paused && timer) { clearTimeout(timer); timer = undefined; left = Math.max(0, left - (Date.now() - since)); }
      else if (!paused && !timer) arm();
    },
    stop() { done = true; clearTimeout(timer); },
  };
}

/**
 * Esegue una chiamata con un tempo massimo. L'errore che ne esce è già pronto da mostrare:
 * tempo scaduto riconosciuto dal segnale (non dal testo: "504 Gateway Timeout" è un errore
 * del provider, non un nostro tempo scaduto) e chiavi mascherate.
 *
 * Con `hardMs` > `ms`: chi allo scadere di `ms` sta già scrivendo (ultimo testo ricevuto con `progress` non vuoto)
 * può finire finché manda pezzi (l'attesa senza pezzi `idleMs` la decide l'adapter), fino a `hardMs`. Se nel
 * tempo in più il tentativo fallisce e il testo si azzera (`progress("")`), l'intervento scade subito: una riserva
 * non riparte da capo fuori tempo.
 */
export async function withBudget<T>(ms: number, signal: AbortSignal,
                                    run: (budget: AbortSignal, hold: (paused: boolean) => void, progress: (text: string) => void) => Promise<T>,
                                    hardMs = ms): Promise<T> {
  // Il tempo si ferma mentre l'intervento aspetta il posto nella coda del provider (`hold(true)`): l'attesa
  // dipende dagli altri, non dal modello.
  const timeout = new AbortController();
  // `stopped`: scaduto perché nel tempo in più il tentativo si è fermato; l'errore vero (es. "nessun testo da 20 s")
  // è quello che l'adapter lancia subito dopo aver azzerato il testo.
  let writing = false, overtime = false, hardHit = false, stopped = false;
  const expire = (hard: boolean, byStop = false) => {
    if (timeout.signal.aborted) return;
    hardHit = hard;
    stopped = byStop;
    timeout.abort(new DOMException("tempo scaduto", "TimeoutError"));
  };
  const soft = pausableTimer(ms, () => { if (writing && hardMs > ms) overtime = true; else expire(false); });
  const hard = pausableTimer(Math.max(ms, hardMs), () => expire(true));
  const hold = (paused: boolean) => { if (!timeout.signal.aborted) { soft.pause(paused); hard.pause(paused); } };
  const progress = (text: string) => { writing = text !== ""; if (overtime && !writing) expire(false, true); };
  try {
    return await run(AbortSignal.any([signal, timeout.signal]), hold, progress);
  } catch (e) {
    const timedOut = (timeout.signal.aborted && !stopped) || (e as Error).name === "TimeoutError";
    // Il codice si decide qui, sull'errore originale: il messaggio riscritto non basta sempre a ritrovarlo.
    throw timedOut
      ? new CodedError("timeout", hardHit
        ? `risposta non finita entro ${Math.round(hardMs / 1000)} s`
        : `nessuna risposta entro ${Math.round(ms / 1000)} s`)
      : new CodedError(errorCode(e), redact((e as Error).message));
  } finally {
    soft.stop();
    hard.stop();
  }
}

/**
 * Riga dei tempi di un intervento in server.log (per tarare l'attesa senza pezzi sui dati veri): fase, voce,
 * modello usato, ms al primo pezzo di testo dell'ultimo tentativo che ne ha mandato (dall'inizio dell'intervento;
 * "-" se nessun pezzo), ms totali, ms in coda sul provider, esito. Mai testo né chiavi.
 */
export function meter(phase: string, voice: string) {
  const t0 = Date.now();
  let first: number | undefined, fresh = false, model: string | undefined, queuedMs = 0, queuedSince: number | undefined;
  return {
    text(t: string, m: string) {
      model = m;
      // Testo azzerato: il tentativo è fallito, il prossimo pezzo è di un tentativo nuovo.
      if (!t) { fresh = true; return; }
      if (first === undefined || fresh) { first = Date.now() - t0; fresh = false; }
    },
    queued(q: boolean) {
      if (q) queuedSince ??= Date.now();
      else if (queuedSince !== undefined) { queuedMs += Date.now() - queuedSince; queuedSince = undefined; }
    },
    end(outcome: string, used?: string) {
      const clean = (s: string) => s.replace(/[^\w.:/@+-]/g, "_").slice(0, 80);
      console.error(`[tempi] fase=${phase} voce=${clean(voice)} modello=${clean(used ?? model ?? "-")} primo=${first ?? "-"} ` +
        `totale=${Date.now() - t0} coda=${queuedMs} esito=${clean(outcome)}`);
    },
  };
}

/**
 * Streaming di un messaggio verso l'app: riceve il testo accumulato dall'adapter e lo manda come eventi
 * `delta` (solo la parte nuova, o `reset` se il testo non prolunga quello già mandato), raggruppati ogni
 * DELTA_EVERY_MS. `close()` prima di `message`/`error`: dopo, nessun pezzo in ritardo.
 */
export function streamer(ctx: TurnCtx, phase: Phase, modelId: string, transform?: (raw: string) => string) {
  let sent = "";
  let latest = "";
  let model: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const flush = () => {
    timer = undefined;
    if (closed || latest === sent) return;
    const extra = model ? { model } : {};
    if (sent && latest.startsWith(sent)) ctx.emit({ type: "delta", phase, modelId, text: latest.slice(sent.length), ...extra });
    else ctx.emit({ type: "delta", phase, modelId, text: latest, ...(sent ? { reset: true as const } : {}), ...extra });
    sent = latest;
  };
  return {
    onText: (raw: string, m: string) => {
      if (closed) return;
      latest = transform ? transform(raw) : raw;
      model = m;
      // Un testo che non prolunga quello mandato (riserva, tentativo fallito) parte subito: niente pezzi vecchi in coda.
      if (!latest.startsWith(sent)) { clearTimeout(timer); flush(); return; }
      timer ??= setTimeout(flush, DELTA_EVERY_MS);
    },
    close: () => { closed = true; clearTimeout(timer); },
  };
}

/** Evento `error` e messaggio salvato con lo stesso codice. */
function failure(ctx: TurnCtx, phase: Phase, modelId: string, error: string, code: ErrorCode): void {
  save(ctx, { model_id: modelId, phase, content: null, error, ms: null, error_code: code });
  ctx.emit({ type: "error", phase, modelId, error, error_code: code });
}

/** Lo stesso modello è una voce del consiglio: stesso id, o la Claude CLI da entrambe le parti. */
export function isParticipant(m: ModelDef, participants: ModelDef[]): boolean {
  return participants.some((p) => p.id === m.id || (p.kind === "claude-cli" && m.kind === "claude-cli"));
}

/**
 * Catena di riserve del giudice: prima la scelta, poi Claude, poi gli altri (senza doppioni). Con
 * `participants` le riserve che non hanno partecipato al dibattito passano davanti (la scelta dell'utente
 * resta prima): un giudice esterno è preferibile a uno che giudica anche la propria posizione.
 */
export function chainOf(chosen: ModelDef, others: ModelDef[], claudeModel: string, participants: ModelDef[] = []): ModelDef[] {
  const chain: ModelDef[] = [];
  for (const m of [chosen, withClaudeModel(config.judge, claudeModel), ...others]) {
    if (!chain.some((j) => j.id === m.id)) chain.push(m);
  }
  const [first, ...rest] = chain;
  const outside = rest.filter((m) => !isParticipant(m, participants));
  return [first, ...outside, ...rest.filter((m) => !outside.includes(m))];
}

/**
 * Prova i modelli della catena uno alla volta (tempo massimo JUDGE_BUDGET_MS ciascuno) finché
 * `accept` non va a buon fine; ogni errore lo riceve `fail`. Annullamento: eccezione "cancelled".
 */
export async function firstInChain(
  chain: ModelDef[], ctx: TurnCtx,
  attempt: (m: ModelDef, budget: AbortSignal, progress: (text: string) => void, onQueued: (queued: boolean) => void) => Promise<void>,
  fail: (m: ModelDef, error: string, code: ErrorCode) => void,
  totalMs = Infinity,
): Promise<boolean> {
  // Come per i partecipanti, l'attesa del posto nella coda del provider (`onQueued`) non conta: né nel tempo del
  // tentativo (`hold` ferma i timer di withBudget) né nel tetto totale (`queuedMs` lo sposta in avanti).
  const until = Date.now() + totalMs;
  let queuedMs = 0;
  let queuedSince: number | undefined;
  for (const m of chain) {
    // Tempo totale finito: i giudici restanti non si provano (sotto 1 s non c'è spazio per una risposta).
    const left = until + queuedMs - Date.now();
    if (left < 1000) break;
    try {
      // Chi sta scrivendo allo scadere del tetto può finire (fino a JUDGE_HARD_MS), sempre dentro il tetto totale.
      await withBudget(Math.min(JUDGE_BUDGET_MS, left), ctx.signal, (budget, hold, progress) => attempt(m, budget, progress, (queued) => {
        hold(queued);
        if (queued) queuedSince ??= Date.now();
        else if (queuedSince !== undefined) { queuedMs += Date.now() - queuedSince; queuedSince = undefined; }
      }), Math.min(JUDGE_HARD_MS, left));
      return true;
    } catch (e) {
      if (ctx.signal.aborted) throw new Error("cancelled");
      fail(m, (e as Error).message, errorCode(e));
    } finally {
      // Tentativo finito mentre era in coda (tempo scaduto, annullato): l'attesa si chiude qui.
      if (queuedSince !== undefined) { queuedMs += Date.now() - queuedSince; queuedSince = undefined; }
    }
  }
  return false;
}

/**
 * Ricerca sul web: un solo ricercatore, prima delle risposte. Ogni esito diverso dal
 * dossier (nessun ricercatore, errore, tempo scaduto) è non fatale: si prosegue senza.
 */
export async function researchPhase(ctx: TurnCtx, question: string, claudeModel: string, selection: ResearchSelection): Promise<P.Material["research"]> {
  const who = findResearcher(selection);
  if (!who) {
    const note = "Ricerca sul web non disponibile: serve Claude oppure una chiave Groq con GPT-OSS.";
    ctx.emit({ type: "phase", phase: "research", note });
    save(ctx, { model_id: "_note", phase: "research", content: note, error: null, ms: null });
    return undefined;
  }
  ctx.emit({ type: "phase", phase: "research" });
  const m = meter("research", who.def.id);
  try {
    const r = await withBudget(RESEARCH_BUDGET_MS, ctx.signal, (budget) => runResearch(who, question, claudeModel, budget));
    m.end("ok", r.model);
    const modelId = `research:${who.def.id}`;
    save(ctx, { model_id: modelId, phase: "research", content: r.text, error: null, ms: r.ms, model_used: r.model, replaced: r.replaced });
    ctx.emit({ type: "message", phase: "research", modelId, text: r.text, ms: r.ms, model: r.model, replaced: r.replaced });
    return { text: r.text, date: new Date().toISOString().slice(0, 10) };
  } catch (e) {
    m.end(ctx.signal.aborted ? "cancelled" : errorCode(e));
    if (ctx.signal.aborted) throw new Error("cancelled");
    failure(ctx, "research", "research", `ricerca non riuscita, si prosegue senza (${(e as Error).message})`, errorCode(e));
    return undefined;
  }
}

/** Esito finale di un turno: il turno 0 scrive verdetto e titolo, gli altri solo lo stato. */
/** Chiude il turno; restituisce il titolo in vigore (quello scelto dall'utente con Rinomina resta). */
function finish(ctx: TurnCtx, status: "done" | "failed" | "cancelled", verdict: string | null, title: string | null = null, confidence: string | null = null): string | null {
  if (ctx.turn === 0) return finishDebate(ctx.debateId, status, verdict, title, confidence);
  finishTurn(ctx.debateId, status);
  return null;
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export async function runDebate(
  debateId: number,
  question: string,
  models: ModelDef[],
  opts: DebateOptions,
  emit: (e: DebateEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const turn = opts.turn ?? 0;
  // Nei turni ≥ 1 ogni evento porta il numero del turno.
  if (turn > 0) { const out = emit; emit = (e) => out({ ...e, turn }); }
  const ctx: TurnCtx = { debateId, turn, emit, signal };
  const withClaude = (m: ModelDef): ModelDef => withClaudeModel(m, opts.claudeModel);
  models = models.map(withClaude);
  const chosenJudge = withClaude(opts.judge);
  const parent = opts.parentContext ? { question: opts.parentContext.question, verdict: opts.parentContext.verdict } : undefined;
  // Lettere assegnate a caso: "A" non è sempre lo stesso modello.
  const letters = shuffle(LETTERS.slice(0, models.length).split(""));
  const ds: Debater[] = models.map((def, i) => ({ def, letter: letters[i], alive: true }));
  // Ruolo scelto dall'utente (campo additivo): solo se c'è il round di critica, dove agisce.
  const roleOf = (id: string) => (opts.rounds >= 1 ? opts.roles?.[id] : undefined);
  const judgeParticipated = isParticipant(chosenJudge, models);
  const participants = ds.map((d) => {
    const role = roleOf(d.def.id);
    const judge = judgeParticipated && isParticipant(chosenJudge, [d.def]);
    return { id: d.def.id, label: d.def.label, letter: d.letter, ...(role ? { role } : {}), ...(judge ? { judge: true as const } : {}) };
  });
  // Salvate per poter rileggere a chi corrisponde ogni lettera nella cronologia.
  save(ctx, { model_id: "_meta", phase: "start", content: JSON.stringify(participants), error: null, ms: null });
  // Solo i metadati: il testo completo resta nella tabella degli allegati, non torna all'app.
  if (opts.attachments?.length) {
    const meta = opts.attachments.map((a) => ({ name: a.name, kind: a.kind, chars: a.text.length }));
    save(ctx, { model_id: "_attachments", phase: "start", content: JSON.stringify(meta), error: null, ms: null });
  }
  // Immagini vere (turni ≥ 1: anche quelle della discussione); le riceve solo chi è una voce Gemini.
  const images = P.imagesOf(opts.conversation?.attachments, opts.attachments);
  const material: P.Material = {
    attachments: opts.attachments?.length ? opts.attachments : undefined,
    followup: opts.conversation && turn > 0
      ? { conversation: P.conversationBlock(opts.conversation, false), original: opts.conversation.question }
      : undefined,
  };
  emit({
    type: "start", debateId, participants,
    rounds: opts.rounds, judge: chosenJudge.label, judgeParticipated, parentId: opts.parentContext?.id ?? null,
  });

  const alive = () => ds.filter((d) => d.alive);

  /** Esegue una fase in parallelo su tutti i partecipanti ancora attivi. */
  async function phase(name: Phase, build: (d: Debater) => string, store: (d: Debater, t: string) => void,
                       keep?: (d: Debater) => void) {
    emit({ type: "phase", phase: name });
    const started = Date.now();
    // `writing`: l'ultimo testo ricevuto non è vuoto; `lateGrace`: il ritardatario stava scrivendo allo scadere del suo tempo.
    const running = alive().map((d) => ({ d, late: new AbortController(), queued: false, done: false, since: started, writing: false, lateGrace: false }));
    let pending = running.length;
    let answered = 0;
    let lateTimer: ReturnType<typeof setTimeout> | undefined;
    // Il timer parte (o riparte dopo la coda) solo per chi sta davvero lavorando: una voce ancora in coda sul
    // provider non è in ritardo, aspetta gli altri; il suo tempo si conta da quando ha il posto.
    const armLate = () => {
      if (!keep || pending !== 1 || running.length < 2 || answered === 0 || lateTimer) return;
      const last = running.find((x) => !x.done);
      if (!last || last.queued) return;
      const wait = Math.max(STRAGGLER_GRACE_MS, STRAGGLER_FLOOR_MS - (Date.now() - last.since));
      // Chi sta scrivendo non si taglia a metà: lo si lascia finire finché manda pezzi (lo ferma l'attesa senza
      // pezzi dell'adapter, che azzera il testo) e il tetto di sicurezza dell'intervento.
      lateTimer = setTimeout(() => running.forEach((x) => {
        if (x.done) return;
        if (x.writing) x.lateGrace = true;
        else x.late.abort();
      }), wait);
    };
    const finished = (r: (typeof running)[number], ok: boolean) => {
      r.done = true;
      pending--;
      if (ok) answered++;
      // Solo nei round (`keep`): chi resta indietro salta il round e rientra nel successivo. Nella risposta
      // iniziale chi fallisce esce dal dibattito, quindi lì vale solo il tempo massimo. Il timer parte solo se
      // qualcuno ha davvero risposto: se gli altri sono falliti subito (quota, 429) il lento non ha nessuno
      // da far aspettare e tagliarlo lascerebbe il round vuoto.
      armLate();
    };
    await Promise.all(
      running.map(async (run) => {
        const { d, late } = run;
        const live = streamer(ctx, name, d.def.id);
        const tm = meter(name, d.def.id);
        let ok = false;
        try {
          // Ogni intervento ha un tempo massimo: un modello bloccato non ferma il dibattito.
          // In coda: niente tempo dell'intervento né del ritardatario; con il posto si riparte a contare.
          const onQueue = (hold: (p: boolean) => void) => (queued: boolean) => {
            hold(queued);
            tm.queued(queued);
            run.queued = queued;
            if (!queued) { run.since = Date.now(); armLate(); }
          };
          const r = await withBudget(PARTICIPANT_BUDGET_MS, AbortSignal.any([signal, late.signal]),
            // Immagini solo nella risposta iniziale (poi i membri ne discutono a parole) e al giudice: per Qwen
            // costano 2.048 token l'una a ogni chiamata.
            (budget, hold, progress) => chat(d.def, {
              system: P.SYSTEM_DEBATER, user: build(d), images: name === "initial" ? images : undefined, signal: budget,
              onText: (t, m) => {
                run.writing = t !== "";
                progress(t);
                tm.text(t, m);
                // Ritardatario lasciato finire che si ferma (tentativo fallito, testo azzerato): ora salta il round.
                if (run.lateGrace && !run.writing) run.late.abort();
                live.onText(t, m);
              },
              idleMs: STREAM_IDLE_MS, onQueued: onQueue(hold),
            }), PARTICIPANT_HARD_MS);
          live.close();
          tm.end("ok", r.model);
          store(d, r.text);
          save(ctx, { model_id: d.def.id, phase: name, content: r.text, error: null, ms: r.ms, model_used: r.model, replaced: r.replaced });
          emit({ type: "message", phase: name, modelId: d.def.id, text: r.text, ms: r.ms, model: r.model, replaced: r.replaced });
          ok = true;
        } catch (e) {
          live.close();
          tm.end(signal.aborted ? "cancelled" : late.signal.aborted ? "late" : errorCode(e));
          if (signal.aborted) return;
          const raw = late.signal.aborted
            ? `troppo lento: gli altri avevano finito, nessuna risposta entro ${Math.round((Date.now() - started) / 1000)} s`
            : (e as Error).message;
          const code: ErrorCode = late.signal.aborted ? "timeout" : errorCode(e);
          // Senza risposta iniziale il modello esce; nei round successivi salta il round,
          // mantiene la posizione precedente e rientra nel round dopo.
          let error = raw;
          if (keep) { keep(d); (d.skipped ??= []).push(ROUND_OF[name] ?? 0); error = `ha saltato questo round (${raw})`; } else d.alive = false;
          failure(ctx, name, d.def.id, error, code);
        } finally {
          finished(run, ok);
        }
      }),
    );
    clearTimeout(lateTimer);
    if (signal.aborted) throw new Error("cancelled");
  }

  // Sempre in ordine di lettera: nell'ordine dei modelli lo stesso modello sarebbe sempre il primo.
  const byLetter = (a: P.Labeled, b: P.Labeled) => a.label.localeCompare(b.label);
  const others = (d: Debater, pick: (x: Debater) => string | undefined): P.Labeled[] =>
    alive().filter((x) => x !== d && pick(x)).map((x) => ({ label: x.letter, text: pick(x)! })).sort(byLetter);

  // Avvocato del diavolo estratto a caso nel round di critica (serve anche alle note per il giudice).
  let randomDevil: Debater | null = null;

  try {
    if (opts.webSearch) {
      const q = material.followup ? P.followupResearchQuestion(question, material.followup.original) : question;
      // Claude cerca solo se è una voce o il giudice scelto (non le riserve automatiche).
      material.research = await researchPhase(ctx, q, opts.claudeModel, { models, judge: chosenJudge });
    }

    // Fase iniziale: risposte indipendenti.
    await phase("initial", () => P.initialPrompt(question, parent, material), (d, t) => (d.initial = t));

    if (opts.rounds >= 1 && alive().length === 1) {
      // Da soli non si discute: si va direttamente al verdetto, e lo si dice.
      emit({ type: "phase", phase: "critique", note: "Round saltati: ha risposto un solo modello, non c'è nessuno con cui discutere." });
      save(ctx, { model_id: "_note", phase: "critique", content: "Round saltati: ha risposto un solo modello.", error: null, ms: null });
    }
    if (opts.rounds >= 1 && alive().length >= 2) {
      // Round 1: critica incrociata. Ruoli scelti dall'utente; se tra i partecipanti attivi nessuno è avvocato
      // del diavolo, ne tocca uno a caso tra quelli senza ruolo (o tra tutti, se ognuno ha un ruolo).
      const roles = opts.roles ?? {};
      const hasDevil = alive().some((d) => roles[d.def.id] === "devil");
      const free = alive().filter((d) => !roles[d.def.id]);
      const pool = free.length ? free : alive();
      randomDevil = hasDevil ? null : pool[Math.floor(Math.random() * pool.length)];
      await phase(
        "critique",
        (d) => P.critiquePrompt(question, d.initial!, others(d, (x) => x.initial), d === randomDevil ? "devil" : roles[d.def.id] ?? null, material, d.letter),
        (d, t) => (d.critique = t),
        () => {},
      );

      if (opts.rounds >= 2) {
        // Round 2: ognuno risponde alle critiche e rivede la propria risposta.
        const allCritiques = () => alive().filter((x) => x.critique).map((x) => ({ label: x.letter, text: x.critique! })).sort(byLetter);
        await phase("revise", (d) => P.revisePrompt(question, d.initial!, allCritiques(), material, d.letter), (d, t) => (d.revised = t),
          (d) => { d.revised = d.initial; });

        if (opts.rounds >= 3) {
          // Arresto anticipato: se nessuno ha cambiato nulla, il round 3 non aggiunge valore.
          const changes = alive().map((d) => P.parseChanges(d.revised ?? ""));
          if (alive().length >= 2 && changes.every((c) => c === "nessuno")) {
            const note = "Round 3 saltato: nessun partecipante ha cambiato posizione.";
            emit({ type: "phase", phase: "final", note });
            // Salvata come le altre note: riaprendo la discussione si vede perché manca il round.
            save(ctx, { model_id: "_note", phase: "final", content: note, error: null, ms: null });
            for (const d of alive()) d.final = d.revised;
          } else {
            await phase("final", (d) => P.finalPrompt(question, d.revised!, others(d, (x) => x.revised), material, d.letter), (d, t) => (d.final = t),
              (d) => { d.final = d.revised; });
          }
        }
      }
    }

    const finals = alive()
      .map((d) => ({ label: d.letter, text: d.final ?? d.revised ?? d.initial ?? "" }))
      .filter((f) => f.text)
      .sort(byLetter);
    if (finals.length === 0) throw new CodedError("no_answer", "Nessun modello ha risposto. Controlla le chiavi con: npm run check");
    const critiques = ds.filter((d) => d.critique).map((d) => ({ label: d.letter, text: d.critique! })).sort(byLetter);

    // Verdetto: prima il giudice scelto, poi Claude se non ha partecipato, poi gli altri partecipanti attivi
    // (es. se Claude ha raggiunto il limite Pro).
    emit({ type: "phase", phase: "verdict" });
    const judges = chainOf(chosenJudge, alive().map((d) => d.def), opts.claudeModel, models).slice(0, JUDGE_CHAIN_MAX);
    const initials = ds.filter((d) => d.initial).map((d) => ({ label: d.letter, text: d.initial! })).sort(byLetter);
    // Note per il giudice: ruolo (solo se il round di critica c'è stato), round saltati, risposte troncate.
    const roles = opts.roles ?? {};
    const critiqueHeld = ds.some((d) => d.critique);
    const meta: Record<string, P.MemberMeta> = Object.fromEntries(ds.filter((d) => d.initial).map((d) => [d.letter, {
      role: critiqueHeld ? (d === randomDevil ? "devil" : roles[d.def.id] ?? null) : null,
      skippedRounds: d.skipped ?? [],
      truncated: [d.initial, d.critique, d.revised, d.final].some(P.isTruncated),
    }]));
    const judgeUser = P.judgePrompt(question, finals, critiques, parent, material, initials, meta);
    let verdict: string | undefined;
    let title: string | null = null;
    let confidence: P.Confidence = null;
    await firstInChain(judges, ctx, async (j, budget, progress, queued) => {
      const live = streamer(ctx, "verdict", `judge:${j.id}`, P.draftVerdict);
      const tm = meter("verdict", j.id);
      const onText = (t: string, m: string) => { progress(t); tm.text(t, m); live.onText(t, m); };
      const onQueued = (q: boolean) => { queued(q); tm.queued(q); };
      const r = await chat(j, { system: P.judgeSystem(isParticipant(j, models)), user: judgeUser, images, maxTokens: 8192, signal: budget, onText, idleMs: JUDGE_IDLE_MS, onQueued })
        .then((x) => { tm.end("ok", x.model); return x; }, (e) => { tm.end(ctx.signal.aborted ? "cancelled" : errorCode(e)); throw e; })
        .finally(live.close);
      // Riga TITOLO e riga AFFIDABILITÀ in qualunque ordine: si tolgono entrambe dal verdetto.
      const split = P.splitTitle(r.text);
      const conf = P.splitConfidence(split.verdict);
      // Sintesi del dibattito (scritta prima) spostata dopo il verdetto, oltre il separatore.
      split.verdict = P.splitDebate(conf.verdict);
      // Solo la riga del titolo, niente verdetto: si prova il giudice successivo.
      if (!split.verdict.trim()) throw new Error("verdetto vuoto");
      // Nei turni ≥ 1 il titolo della discussione non cambia.
      title = turn === 0 ? split.title : null;
      confidence = conf.confidence;
      verdict = j.id === chosenJudge.id ? split.verdict : `> Giudice di riserva: ${j.label} (${chosenJudge.label} non disponibile)\n\n${split.verdict}`;
      save(ctx, { model_id: `judge:${j.id}`, phase: "verdict", content: verdict, error: null, ms: r.ms, confidence });
      emit({ type: "message", phase: "verdict", modelId: `judge:${j.id}`, text: verdict, ms: r.ms, confidence });
    }, (j, error, code) => failure(ctx, "verdict", `judge:${j.id}`, error, code), VERDICT_BUDGET_MS);
    if (!verdict) throw new CodedError("no_verdict", "Nessun giudice ha prodotto il verdetto.");

    // Titolo rinominato dall'utente durante il dibattito: resta quello, anche nell'evento.
    const shown = finish(ctx, "done", verdict, title, confidence);
    emit({ type: "done", status: "done", verdict, ...(shown ? { title: shown } : {}), confidence });
  } catch (e) {
    const cancelled = signal.aborted;
    const error = cancelled ? (turn > 0 ? "Turno annullato" : "Dibattito annullato") : redact((e as Error).message);
    finish(ctx, cancelled ? "cancelled" : "failed", null);
    emit({ type: "done", status: cancelled ? "cancelled" : "failed", error, error_code: cancelled ? "cancelled" : errorCode(e) });
  }
}

export interface QuickOptions {
  /** Risponditore scelto (prima scelta della catena, come il giudice). */
  responder: ModelDef;
  claudeModel: string;
  /** Riserve oltre a Claude: i partecipanti del dibattito originale. */
  fallbacks: ModelDef[];
  webSearch?: boolean;
  attachments?: P.Attachment[];
  conversation: P.Conversation;
}

/**
 * Risposta rapida a una domanda di seguito (turno ≥ 1): risponde un solo modello, con la catena di
 * riserve e il tempo massimo del giudice. Eventi: phase "answer" → message o error → done.
 */
export async function runQuickAnswer(
  debateId: number, turn: number, question: string, opts: QuickOptions,
  emit: (e: DebateEvent) => void, signal: AbortSignal,
): Promise<void> {
  const out = emit;
  emit = (e) => out({ ...e, turn });
  const ctx: TurnCtx = { debateId, turn, emit, signal };
  const chosen = withClaudeModel(opts.responder, opts.claudeModel);
  const material: P.Material = { attachments: opts.attachments?.length ? opts.attachments : undefined };
  try {
    if (opts.webSearch) {
      // Voci della discussione e risponditore scelto (al posto del giudice).
      material.research = await researchPhase(ctx, P.followupResearchQuestion(question, opts.conversation.question), opts.claudeModel,
        { models: opts.fallbacks, judge: chosen });
    }
    emit({ type: "phase", phase: "answer" });
    const user = P.quickPrompt(question, P.conversationBlock(opts.conversation, true), material);
    const chain = chainOf(chosen, opts.fallbacks.map((m) => withClaudeModel(m, opts.claudeModel)), opts.claudeModel);
    const ok = await firstInChain(chain, ctx, async (m, budget, progress, queued) => {
      const live = streamer(ctx, "answer", m.id);
      const tm = meter("answer", m.id);
      const onText = (t: string, model: string) => { progress(t); tm.text(t, model); live.onText(t, model); };
      const onQueued = (q: boolean) => { queued(q); tm.queued(q); };
      const r = await chat(m, { system: P.SYSTEM_RESPONDER, user, images: P.imagesOf(opts.conversation.attachments, opts.attachments), signal: budget, onText, idleMs: JUDGE_IDLE_MS, onQueued })
        .then((x) => { tm.end("ok", x.model); return x; }, (e) => { tm.end(ctx.signal.aborted ? "cancelled" : errorCode(e)); throw e; })
        .finally(live.close);
      if (!r.text.trim()) throw new Error("risposta vuota");
      const text = m.id === chosen.id ? r.text : `> Risposta di riserva: ${m.label} (${chosen.label} non disponibile)\n\n${r.text}`;
      save(ctx, { model_id: m.id, phase: "answer", content: text, error: null, ms: r.ms, model_used: r.model, replaced: r.replaced });
      emit({ type: "message", phase: "answer", modelId: m.id, text, ms: r.ms, model: r.model, replaced: r.replaced });
    }, (m, error, code) => failure(ctx, "answer", m.id, error, code));
    if (!ok) throw new CodedError("no_answer", "Nessun modello ha risposto alla domanda.");
    finishTurn(debateId, "done");
    emit({ type: "done", status: "done" });
  } catch (e) {
    const cancelled = signal.aborted;
    finishTurn(debateId, cancelled ? "cancelled" : "failed");
    emit({ type: "done", status: cancelled ? "cancelled" : "failed", error: cancelled ? "Turno annullato" : redact((e as Error).message), error_code: cancelled ? "cancelled" : errorCode(e) });
  }
}
