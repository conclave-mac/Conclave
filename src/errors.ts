/**
 * Codici d'errore stabili (campo additivo `error_code` su messaggi ed eventi `error`/`done`).
 * Il testo italiano dell'errore resta com'è (cronologia, esportazioni, motore senza app); l'app usa
 * il codice per mostrare un testo tradotto con un'azione chiara. I valori non vanno mai rinominati.
 */
export type ErrorCode =
  | "rate_limited"     // servizio occupato o limite di richieste al minuto: si riprova tra poco
  | "quota_exhausted"  // quota del piano esaurita (giornaliera, crediti, limite di Claude Pro)
  | "invalid_key"      // chiave rifiutata dal provider
  | "missing_key"      // chiave non configurata
  | "network"          // provider non raggiungibile
  | "model_retired"    // modello ritirato o inesistente
  | "timeout"          // nessuna risposta in tempo (anche: troppo lento rispetto agli altri)
  | "interrupted"      // risposta interrotta a metà
  | "too_long"         // richiesta oltre il limite del piano o del contesto
  | "empty"            // risposta vuota
  | "claude_unavailable" // Claude CLI non avviabile
  | "provider_error"   // altro errore HTTP del provider
  | "no_answer"        // nessun modello ha risposto
  | "no_verdict"       // nessun giudice ha prodotto il verdetto
  | "cancelled"
  | "unknown";

const CODES = new Set<string>([
  "rate_limited", "quota_exhausted", "invalid_key", "missing_key", "network", "model_retired", "timeout",
  "interrupted", "too_long", "empty", "claude_unavailable", "provider_error", "no_answer", "no_verdict", "cancelled", "unknown",
]);

/** Errore con un codice già deciso da chi l'ha creato (vince sulla classificazione dal testo). */
export class CodedError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string, name?: string) {
    super(message);
    this.code = code;
    if (name) this.name = name;
  }
}

/**
 * Codice di un errore. Si guarda prima un codice esplicito, poi il testo: gli errori passano per
 * `withBudget` e le catene di riserve che li riscrivono, ma il testo conserva "HTTP 429: …" e le
 * frasi del motore. L'ordine conta: "Request too large" arriva con un 429 ma è un problema di lunghezza.
 */
export function errorCode(e: unknown): ErrorCode {
  const c = (e as { code?: unknown })?.code;
  if (typeof c === "string" && CODES.has(c)) return c as ErrorCode;
  const m = typeof e === "string" ? e : String((e as Error)?.message ?? e ?? "");
  if (/annullat/i.test(m)) return "cancelled";
  if (/chiave \S+ mancante/i.test(m)) return "missing_key";
  if (/HTTP 40[13]\b|api key not valid|invalid api key|incorrect api key|invalid_api_key|unauthori[sz]ed|authentication|permission denied/i.test(m)) return "invalid_key";
  if (/HTTP 413\b|request too large|reduce your message size|context length|maximum context|context window|prompt is too long|too many tokens/i.test(m)) return "too_long";
  if (/exceeded your current quota|insufficient_quota|limit: 0\b|per day|\(RPD\)|\(TPD\)|usage limit|credit balance|out of credits|quota/i.test(m)) return "quota_exhausted";
  if (/HTTP 429\b|HTTP 50[23]\b|HTTP 529\b|overloaded|rate limit|too many requests|sovraccaric/i.test(m)) return "rate_limited";
  if (/HTTP 404\b|model not found|does not exist|decommissioned|has been deprecated|no longer (supported|available)/i.test(m)) return "model_retired";
  if (/risposta interrotta/i.test(m)) return "interrupted";
  if (/nessuna risposta entro|troppo lento|nessun testo da|TimeoutError|timed? ?out/i.test(m)) return "timeout";
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|non raggiungibile/i.test(m)) return "network";
  if (/risposta vuota|verdetto vuoto/i.test(m)) return "empty";
  if (/claude non avviabile/i.test(m)) return "claude_unavailable";
  if (/nessun modello ha risposto/i.test(m)) return "no_answer";
  if (/nessun giudice/i.test(m)) return "no_verdict";
  if (/HTTP \d{3}\b/.test(m)) return "provider_error";
  return "unknown";
}
