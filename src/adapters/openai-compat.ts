import type { Provider } from "../config.ts";
import type { ChatRequest, ChatResult } from "./types.ts";
import { redact } from "../redact.ts";
import { CodedError, isDailyOrPlanLimit } from "../errors.ts";

const TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;
const ATTEMPT_WITH_RESERVE_MS = 35_000;
/**
 * Streaming: tempo massimo senza alcun dato dal provider. 20 s dai tempi reali (nov 2026, risposte intere):
 * Gemini al 90° percentile 11 s, GPT-OSS al massimo 8 s, Claude CLI 24–26 s ma con i primi pezzi dopo
 * l'avvio del processo; Nemotron (OpenRouter, fino a 57 s) manda commenti e ragionamento mentre pensa.
 */
export const STREAM_IDLE_MS = 20_000;
/** Attesa delle intestazioni con lo streaming: chi ignora `stream: true` le manda solo a risposta pronta. */
export const HEADERS_WAIT_MS = 45_000;

export class HttpError extends Error {
  status: number;
  retryAfter: number;
  constructor(status: number, message: string, retryAfter: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * Caratteri tipografici che alcuni modelli (GPT-OSS) usano a centinaia: spazi stretti
 * e trattini non separabili rendono difficili ricerca e copia. Si portano a quelli normali.
 */
export function normalizeText(s: string): string {
  return s
    .replace(/[    ]/g, " ")
    .replace(/[‐‑]/g, "-")
    .replace(/​/g, "");
}

/** Rimandi interni di GPT-OSS ai risultati dello strumento (es. "【2†L6-L10】"): per chi legge non significano nulla. */
export function stripCitations(s: string): string {
  return s.replace(/[ \t]*【[^】\n]{0,40}】/g, "").trim();
}

/**
 * Aggiunge in fondo gli indirizzi delle pagine consultate dallo strumento di ricerca
 * (`executed_tools` di Groq) che il testo non cita già: il dossier deve avere fonti verificabili.
 * La forma della risposta non è documentata in dettaglio: si cercano campi `url` ovunque.
 */
export function withSources(text: string, tools: unknown): string {
  const urls = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || urls.size >= 20 || v === null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "url" && typeof x === "string" && /^https?:\/\/\S+$/.test(x) && x.length < 500) urls.add(x);
      else walk(x, depth + 1);
    }
  };
  walk(tools, 0);
  const missing = [...urls].filter((u) => !text.includes(u)).slice(0, 10);
  return missing.length ? `${text}\n\n**Pagine consultate**\n${missing.map((u) => `- ${u}`).join("\n")}` : text;
}

/** "Please try again in 22.5s" / "1m2.5s" / "750ms" → secondi (0 se assente). */
export function parseTryAgain(msg: string): number {
  // Prima i millisecondi: l'altra forma accetta anche la stringa vuota e "750ms" dava 0.
  const m = msg.match(/try again in\s+([\d.]+ms|(?:\d+h)?(?:\d+m(?!s))?(?:[\d.]+s)?)/i);
  if (!m || !m[1]) return 0;
  const t = m[1];
  if (/^[\d.]+ms$/.test(t)) return Number(t.slice(0, -2)) / 1000;
  const h = Number(t.match(/(\d+)h/)?.[1] ?? 0);
  const min = Number(t.match(/(\d+)m(?!s)/)?.[1] ?? 0);
  const s = Number(t.match(/([\d.]+)s/)?.[1] ?? 0);
  return h * 3600 + min * 60 + s;
}

/**
 * Richieste in volo per provider (stesso indirizzo e stessa chiave): due dibattiti insieme sulla stessa chiave
 * Groq gratuita (~8.000 token al minuto) davano raffiche di 429. Si attende il proprio turno, interrompibile.
 * `maxConcurrent` nel provider di models.json lo cambia; i server locali (Ollama, LM Studio, i finti delle
 * prove) gestiscono la coda da soli: nessun limite salvo `maxConcurrent` esplicito.
 */
export const PROVIDER_SLOTS = 3;
const slots = new Map<string, { busy: number; queue: (() => void)[] }>();

export function providerSlots(p: Provider): number {
  const n = (p as Provider & { maxConcurrent?: unknown }).maxConcurrent;
  if (typeof n === "number" && Number.isInteger(n) && n >= 1) return n;
  try {
    const host = new URL(p.baseUrl).hostname;
    if (["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) return Infinity;
  } catch { /* indirizzo non valido: limite predefinito */ }
  return PROVIDER_SLOTS;
}

/** Prende un posto per il provider (passato di mano in mano quando si libera); restituisce la funzione che lo rilascia. */
export async function acquireSlot(p: Provider, signal?: AbortSignal): Promise<() => void> {
  const limit = providerSlots(p);
  if (limit === Infinity) return () => {};
  const key = `${p.baseUrl}|${p.keyEnv}`;
  let s = slots.get(key);
  if (!s) slots.set(key, (s = { busy: 0, queue: [] }));
  const st = s;
  if (st.busy < limit) st.busy++;
  else {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("annullato"));
      const go = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
      const onAbort = () => {
        const i = st.queue.indexOf(go);
        if (i >= 0) st.queue.splice(i, 1);
        reject(signal!.reason ?? new Error("annullato"));
      };
      st.queue.push(go);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = st.queue.shift();
    if (next) next(); // il posto passa a chi aspetta: `busy` resta uguale
    else st.busy--;
  };
}

/** Attesa interrompibile: se il dibattito viene annullato o scade il tempo, si smette subito. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("annullato"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal!.reason ?? new Error("annullato")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Tetto di token in uscita imparato per modello: alcuni piani gratuiti (es. Qwen su Groq,
 * 1.000 token/minuto) rifiutano le richieste con max_tokens più alto del loro limite.
 */
const outputCap = new Map<string, number>();

/** "…expected output tokens exceed… Limit 1000…" → tetto da usare (80% del limite), o 0. */
export function outputLimitFrom(message: string): number {
  if (!/reduce max_tokens|expected output tokens exceed|max_tokens.*(too large|exceed)/i.test(message)) return 0;
  const lim = Number(message.match(/Limit\s+(\d+)/i)?.[1] ?? 0);
  return lim > 0 ? Math.max(200, Math.floor(lim * 0.8)) : 0;
}

/**
 * "…output tokens per minute (OTPM): Limit 1000, Used 608, Requested 767…" → token in uscita ancora
 * disponibili in questo minuto, se bastano per una risposta utile (almeno 300), altrimenti 0.
 */
export function outputRoomFrom(message: string): number {
  const m = message.match(/Limit\s+(\d+),\s*Used\s+(\d+),\s*Requested\s+(\d+)/i);
  if (!m || !/output tokens/i.test(message)) return 0;
  const [lim, used, requested] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const room = Math.floor((lim - used) * 0.95);
  return room >= 300 && room < requested ? room : 0;
}

/** Errore 429 che non si risolve aspettando qualche secondo. */
export function isHardLimit(message: string): boolean {
  // Google scrive "exceeded your current quota" anche per il limite al minuto, con "retry in Xs": lì si aspetta.
  return isDailyOrPlanLimit(message) || /reduce your message size|request too large/i.test(message)
    || (/exceeded your current quota/i.test(message) && !/retry in|try again in|per ?minute|PerMinute/i.test(message));
}

/** Modelli che hanno risposto 400 alle immagini: non si riprovano più (in memoria fino al riavvio). */
const imageRefused = new Set<string>();

/**
 * Modelli che ricevono le immagini vere, con il massimo per richiesta e i token che costa ognuna. Gemini sì
 * (Gemma no: non si sa se le accetti); su Groq solo Qwen 3.8 27B, al massimo 3 immagini (2.048 token l'una).
 * `provider`: la regola vale solo su quel provider (stesso id di Qwen su OpenRouter = un altro servizio, che
 * non sappiamo se accetti le immagini). Si confronta con indirizzo e nome del provider.
 */
const IMAGE_MODELS: { test: RegExp; max: number; tokens: number; provider?: RegExp }[] = [
  { test: /^(models\/)?gemini/i, max: Infinity, tokens: 258 },
  { test: /^qwen\/qwen3\.8-27b$/i, max: 3, tokens: 2048, provider: /groq/i },
];

const imageRule = (model: string, p?: Provider) => {
  const rule = IMAGE_MODELS.find((r) => r.test.test(model));
  if (!rule || (p && rule.provider && !rule.provider.test(`${p.baseUrl} ${p.name ?? ""}`))) return undefined;
  return rule;
};

/**
 * Immagini da mandare a questo modello: nessuna se non le accetta, al massimo quante ne accetta. Senza
 * provider (prove) conta solo il modello.
 */
export function imagesFor(model: string, images?: string[], p?: Provider): string[] {
  const rule = imageRule(model, p);
  return images?.length && rule && !imageRefused.has(model) ? images.slice(0, rule.max) : [];
}

/**
 * Richiesta troppo grande anche senza immagini: Groq scrive "Limit 8000, Requested 9500" (token). Se togliendo
 * la stima dei token delle immagini si resta oltre il limite, riprovare con il solo testo non serve.
 * Senza numeri nel messaggio non si sa: si prova (false).
 */
export function textAloneTooLarge(message: string, model: string, images: number, p?: Provider): boolean {
  const m = message.match(/Limit\s+(\d+)(?:,\s*Used\s+\d+)?,\s*Requested\s+(\d+)/i);
  if (!m) return false;
  const perImage = imageRule(model, p)?.tokens ?? 0;
  return Number(m[2]) - images * perImage > Number(m[1]);
}

const IMAGES_NOTE = "\n\nLe immagini allegate sono unite a questo messaggio.";

/** Richiesta troppo grande per il limite di token del piano (Groq: 413, o 429 "Request too large"). */
function tooLarge(e: HttpError): boolean {
  // "Request too large… reduce max_tokens" riguarda l'uscita richiesta: lì si abbassa max_tokens, le immagini restano.
  if (outputLimitFrom(e.message) > 0) return false;
  return e.status === 413 ||(e.status === 429 && /request too large|reduce your message size/i.test(e.message));
}

/** Contenuto del messaggio utente: testo semplice, o testo + immagini (data URL) se ce ne sono. */
function userContent(user: string, images: string[], total: number): string | unknown[] {
  if (!images.length) return user;
  // Se il modello ne accetta meno di quelle allegate, lo si dice: le altre restano solo come testo.
  const note = images.length < total
    ? `${IMAGES_NOTE} Per limiti del modello ne ricevi solo ${images.length} su ${total}: delle altre hai solo il testo estratto.`
    : IMAGES_NOTE;
  return [
    { type: "text", text: user + note },
    ...images.map((b64) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } })),
  ];
}

/** Testo visibile durante lo streaming: senza ragionamento tra <think> (anche non ancora chiuso) né un "<thi" in coda. */
export function visibleText(raw: string): string {
  return normalizeText(raw.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").replace(/<(t(h(i(nk?)?)?)?)?$/, "")).trimStart();
}

/** Testo finale di una risposta: niente ragionamento, caratteri normalizzati, avviso se troncata. */
function finalText(content: string, finish: unknown, req: ChatRequest, tools?: unknown): string {
  // Alcuni modelli di ragionamento includono il "pensiero" tra tag <think>.
  let text = normalizeText(content.replace(/<think>[\s\S]*?<\/think>/g, "")).trim();
  if (req.webSearch) text = withSources(stripCitations(text), tools);
  if (!text) throw new CodedError("empty", "risposta vuota dal modello");
  // Risposta tagliata dal limite di lunghezza: lo si dichiara, così giudice e utente lo sanno.
  if (finish === "length") text += "\n\n[…risposta troncata dal limite di lunghezza]";
  return text;
}

/** Messaggio d'errore del provider (Google a volte lo mette in un array: [{ error: {...} }]). */
function providerMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const j = Array.isArray(parsed) ? parsed[0] : parsed;
    const m = j?.error?.message ?? j?.message;
    if (typeof m === "string") return m;
  } catch { /* risposta non JSON */ }
  return raw.slice(0, 300);
}

/**
 * Legge una risposta in streaming (Server-Sent Events nel formato OpenAI: `data: {chunk}` … `data: [DONE]`).
 * Ogni byte ricevuto (anche i commenti ": OPENROUTER PROCESSING" e i pezzi di solo ragionamento) azzera
 * l'attesa di `touch`. Un errore nel flusso (OpenRouter: chunk con `error` e `finish_reason: "error"` su
 * HTTP 200) o un flusso chiuso prima della fine è un errore: il testo parziale non vale come risposta.
 */
async function readStream(res: Response, model: string, req: ChatRequest, touch: () => void): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  let content = "";
  let shown = "";
  let finish: unknown = null;
  let done = false;
  const onEvent = (payload: string) => {
    if (payload === "[DONE]") { done = true; return; }
    let j: any;
    try { j = JSON.parse(payload); } catch { return; } // pezzo illeggibile: si ignora, come fanno gli SDK
    if (j?.error) {
      const msg = redact(String(j.error.message ?? j.error).slice(0, 300));
      const status = Number(j.error.code ?? j.error.status);
      // Prima di qualunque testo è un errore del provider come gli altri (429, 5xx → riserva o attesa).
      if (!content && status >= 400 && status < 600) throw new HttpError(status, `HTTP ${status}: ${msg}`, parseTryAgain(msg));
      throw new CodedError("interrupted", `risposta interrotta a metà: ${msg}`);
    }
    const c = j?.choices?.[0];
    if (c?.finish_reason) finish = c.finish_reason;
    const piece = c?.delta?.content;
    if (typeof piece === "string" && piece) {
      content += piece;
      const vis = visibleText(content);
      if (vis !== shown) { shown = vis; req.onText?.(vis, model); }
    }
  };
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        // Annullamento e attese scadute restano tali; il resto è la connessione caduta a metà ("terminated").
        if (["AbortError", "TimeoutError", "StallError"].includes((e as Error).name)) throw e;
        throw new CodedError("interrupted", `risposta interrotta: connessione chiusa a metà (${redact((e as Error).message).slice(0, 120)})`);
      }
      const { value, done: end } = chunk;
      if (end) break;
      touch();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") { if (data.length) onEvent(data.join("\n")); data = []; }
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        // Altre righe (commenti ":", "event:", "id:") non portano testo.
      }
      if (done) break;
    }
    // Ultima riga senza a capo finale (flusso chiuso subito dopo): si legge comunque.
    const tail = buf.replace(/\r$/, "");
    if (tail.startsWith("data:")) data.push(tail.slice(5).replace(/^ /, ""));
    if (data.length) onEvent(data.join("\n"));
  } finally {
    // Errore nel flusso o [DONE] prima della fine del corpo: la connessione non resta aperta.
    reader.cancel().catch(() => {});
  }
  if (finish === "error") throw new CodedError("interrupted", "risposta interrotta a metà dal provider");
  if (!done && !finish) throw new CodedError("interrupted", "risposta interrotta: la connessione si è chiusa prima della fine");
  return finalText(content, finish, req);
}

export async function once(p: Provider, model: string, req: ChatRequest, timeoutMs = TIMEOUT_MS): Promise<string> {
  const key = process.env[p.keyEnv]?.trim();
  if (!key) throw new CodedError("missing_key", `chiave ${p.keyEnv} mancante: aggiungila in Impostazioni ▸ Chiavi API`);
  // Il turno si aspetta prima di far partire i tempi del tentativo; l'attesa la ferma il segnale del round.
  const release = await acquireSlot(p, req.signal);
  try {
    return await attempt(p, model, key, req, timeoutMs);
  } finally {
    release();
  }
}

async function attempt(p: Provider, model: string, key: string, req: ChatRequest, timeoutMs: number): Promise<string> {

  // Streaming solo per chi lo chiede; la ricerca sul web resta intera (servono le fonti di `executed_tools`).
  const streaming = !!req.onText && !req.webSearch;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (req.signal) signals.push(req.signal);
  // Nessun dato per `idleMs` (prima delle intestazioni o tra due pezzi): il tentativo si ferma.
  const idle = new AbortController();
  const idleMs = req.idleMs ?? STREAM_IDLE_MS;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touch = (ms = idleMs) => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(new CodedError("timeout", `nessun testo dal modello da ${Math.round(ms / 1000)} s`, "StallError")), ms);
  };
  // Prima delle intestazioni un'attesa più lunga: un provider che ignora `stream: true` le manda solo a
  // risposta pronta (prima del 20 nov il limite per tentativo era 35–45 s).
  if (streaming) { signals.push(idle.signal); touch(Math.max(idleMs, HEADERS_WAIT_MS)); }
  // Primo testo entro `firstTextMs` (solo con una riserva dietro): i commenti SSE non bastano.
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  if (streaming && req.firstTextMs) {
    const s = Math.round(req.firstTextMs / 1000);
    firstTimer = setTimeout(() => idle.abort(new CodedError("timeout", `nessun testo dal modello entro ${s} s`, "StallError")), req.firstTextMs);
  }
  // Testo mostrato e poi scartato (tentativo fallito a metà): la card torna vuota per chi riparte.
  let shown = false;
  const r: ChatRequest = streaming ? { ...req, onText: (t, m) => { shown = true; clearTimeout(firstTimer); req.onText!(t, m); } } : req;

  try {
    let res: Response;
    try {
      res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          // Intestazioni facoltative richieste da OpenRouter per identificare l'app.
          "HTTP-Referer": "http://localhost",
          "X-Title": "Conclave",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: userContent(req.user, imagesFor(model, req.images, p), req.images?.length ?? 0) },
          ],
          // Margine ampio: nei modelli che "ragionano" anche il ragionamento consuma questo limite.
          max_tokens: Math.min(req.maxTokens ?? 4096, outputCap.get(model) ?? Infinity),
          temperature: 0.6,
          ...(streaming ? { stream: true } : {}),
          // Parametri specifici del provider (es. Gemini: ragionamento leggero), da models.json.
          ...(p.extraBody ?? {}),
          // Ricerca sul web di Groq (solo GPT-OSS): strumento eseguito dal provider, ragionamento leggero.
          ...(req.webSearch ? { tools: [{ type: "browser_search" }], reasoning_effort: "low" } : {}),
        }),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      // Errore prima della risposta: annullamento e tempi scaduti restano tali, il resto è la rete.
      if ((e as Error).name === "AbortError" || (e as Error).name === "TimeoutError" || (e as Error).name === "StallError") throw e;
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      throw new CodedError("network", `provider non raggiungibile${cause ? ` (${cause})` : ""}: ${redact((e as Error).message)}`);
    }

    if (!res.ok) {
      const raw = await res.text();
      let msg = providerMessage(raw);
      const ra = Number(res.headers.get("retry-after"));
      const hinted = parseTryAgain(msg);
      // Pubblicità del piano a pagamento in coda agli errori di Groq: inutile nella chat e nelle esportazioni.
      msg = msg.replace(/\s*Need more tokens\?[\s\S]*$/i, "");
      throw new HttpError(res.status, `HTTP ${res.status}: ${redact(msg)}`, Number.isFinite(ra) && ra > 0 ? ra : hinted);
    }

    if (streaming && /text\/event-stream/i.test(res.headers.get("content-type") ?? "")) {
      touch();
      return await readStream(res, model, r, () => touch());
    }
    // Risposta intera: niente attesa tra pezzi, vale il tempo massimo del tentativo.
    clearTimeout(idleTimer);

    // Risposta intera (anche da un provider che ignora `stream: true`).
    const raw = await res.text();
    let j: any;
    try { j = JSON.parse(raw); } catch { throw new Error("risposta non valida dal provider (non è JSON)"); }
    const msg = j.choices?.[0]?.message;
    const text = finalText(typeof msg?.content === "string" ? msg.content : "", j.choices?.[0]?.finish_reason, req, msg?.executed_tools);
    if (streaming) r.onText!(visibleText(text), model);
    return text;
  } catch (e) {
    // L'attesa scaduta interrompe il corpo con l'errore del segnale: si riporta quello, non un AbortError generico.
    if (idle.signal.aborted && !req.signal?.aborted) {
      if (shown) req.onText!("", model);
      throw idle.signal.reason;
    }
    if (shown) req.onText!("", model);
    throw e;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(firstTimer);
  }
}

/**
 * Prova i modelli in ordine: il primo è il principale, gli altri sono di riserva.
 * Un modello ritirato (400/404) passa subito al successivo; uno occupato (429/5xx)
 * passa subito alla riserva, oppure viene ritentato se è l'ultimo modello.
 */
export async function chatOpenAI(p: Provider, models: string[], req: ChatRequest): Promise<ChatResult> {
  const started = Date.now();
  let lastError: unknown;
  for (const [i, model] of models.entries()) {
    const hasNext = i < models.length - 1;
    const maxRetries = hasNext ? 0 : MAX_RETRIES; // con una riserva disponibile non si aspetta
    // Solo per questo modello e questa chiamata: le riserve successive ricevono la richiesta intera.
    let withoutImages = false; // un 400 con le immagini: si riprova una volta con il solo testo
    let imagesTooBig = false;  // richiesta troppo grande con le immagini: senza, ma solo per questa chiamata
    let tighterMax = 0;       // limite di token al minuto quasi esaurito: si chiede meno uscita
    // Contano solo i tentativi con attesa: i riprova immediati (senza immagini, meno token) non li consumano.
    for (let waits = 0; ;) {
      const r: ChatRequest = {
        ...req,
        ...(withoutImages ? { images: undefined } : {}),
        ...(tighterMax ? { maxTokens: Math.min(req.maxTokens ?? 4096, tighterMax) } : {}),
      };
      try {
        // Se c'è una riserva, un modello lento non deve consumare tutto il tempo del round. In streaming lo
        // decide l'attesa senza pezzi (`idleMs`): un modello che sta scrivendo non si taglia a metà.
        // Con una riserva il primo testo deve arrivare entro 35 s come prima (un modello in coda su OpenRouter
        // manda solo commenti e terrebbe vivo il tentativo fino al tetto dell'intervento).
        const text = await once(p, model, { ...r, ...(hasNext && req.onText ? { firstTextMs: ATTEMPT_WITH_RESERVE_MS } : {}) },
          req.timeoutMs ?? (hasNext && !req.onText ? ATTEMPT_WITH_RESERVE_MS : TIMEOUT_MS));
        // Le immagini erano la causa del 400 solo se il solo testo passa: allora non si riprovano più.
        if (withoutImages && !imagesTooBig) imageRefused.add(model);
        return { text, ms: Date.now() - started, model };
      } catch (e) {
        lastError = e;
        if (req.signal?.aborted) throw e;
        // Il provider rifiuta le immagini (o il formato): una volta sola si riprova senza, invece di far fallire la voce.
        // Un 400 per max_tokens oltre il limite (Groq, Qwen) non riguarda le immagini: lo gestisce il tetto più sotto,
        // e il riprova senza immagini le toglierebbe a questo modello fino al riavvio.
        const sent = imagesFor(model, req.images, p).length;
        if (e instanceof HttpError && e.status === 400 && !withoutImages && sent && outputLimitFrom(e.message) === 0) {
          withoutImages = true;
          console.error(`[immagini] ${model} ha risposto 400 con le immagini: riprovo con il solo testo`);
          continue;
        }
        // Immagini oltre il tetto di token del piano gratuito (Qwen su Groq: ~8.000 al minuto): prima di
        // accorciare la risposta o rinunciare, si riprova senza. Le immagini restano attive per le prossime chiamate.
        // Se è troppo grande anche il solo testo (stima dai numeri del provider), togliere le immagini non serve.
        if (e instanceof HttpError && tooLarge(e) && !withoutImages && sent && !textAloneTooLarge(e.message, model, sent, p)) {
          withoutImages = true;
          imagesTooBig = true;
          console.error(`[immagini] ${model}: richiesta troppo grande con le immagini, riprovo con il solo testo`);
          continue;
        }
        // Limite di token in uscita al minuto (Groq: "Limit 1000, Used 608, Requested 767"): se resta
        // margine si riprova subito chiedendo meno token, invece di aspettare e saltare il round.
        // Un'attesa breve (≤ 5 s) è meglio di una risposta più corta (Qwen scrive 500–700 token): lì si aspetta.
        const room = e instanceof HttpError && e.status === 429 ? outputRoomFrom(e.message) : 0;
        const shortWait = e instanceof HttpError && e.retryAfter > 0 && e.retryAfter <= 5;
        if (room > 0 && !tighterMax && !shortWait) {
          tighterMax = room;
          continue;
        }
        // Modello che non risponde in tempo o risposta illeggibile: si passa alla riserva, se c'è.
        if (!(e instanceof HttpError)) {
          req.onModelFail?.(model);
          if (hasNext) break;
          throw e;
        }
        if (e.status === 404) req.onModelFail?.(model);
        const busy = e.status === 429 || e.status >= 500;
        const gone = e.status === 404 || e.status === 400;
        // Quota giornaliera esaurita o richiesta troppo grande: riprovare tra pochi secondi è inutile.
        // Il provider dice che l'uscita richiesta è oltre il suo limite: si abbassa e si riprova subito.
        const cap = outputLimitFrom(e.message);
        if (cap > 0 && (outputCap.get(model) ?? Infinity) > cap) {
          outputCap.set(model, cap);
          continue;
        }
        const quota = e.status === 429 && isHardLimit(e.message);
        if (busy && !quota && waits < maxRetries) {
          // Limite al minuto o sovraccarico: si aspetta quanto indica il provider (max 45 s),
          // altrimenti 5 s, 10 s… L'attesa si interrompe se scade il tempo del round.
          const waitS = Math.min(e.retryAfter > 0 ? e.retryAfter + 0.5 : 5 * (waits + 1), 45);
          await sleep(waitS * 1000, req.signal);
          waits++;
          tighterMax = 0; // minuto nuovo: si richiede di nuovo la lunghezza piena
          continue;
        }
        if ((busy || gone) && hasNext) break; // passa alla riserva
        throw e;
      }
    }
  }
  throw lastError;
}
