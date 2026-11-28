import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ChatResult } from "./types.ts";
import { redact } from "../redact.ts";
import { appKeyNames } from "../bootstrap.ts";
import { config } from "../config.ts";
import { CodedError, isClaudeCreditsMessage } from "../errors.ts";

/** Avviso in fondo a una risposta tagliata dal limite di token (lo stesso dell'adapter OpenAI-compat). */
const TRUNCATION_NOTE = "\n\n[…risposta troncata dal limite di lunghezza]";

/**
 * Errore di Claude: se chiede un credito o un piano separato per l'uso programmatico (`claude -p`) ha un codice
 * suo, così l'app non lo confonde con un errore generico del provider né con il limite di utilizzo di Pro.
 */
const claudeError = (message: string): Error =>
  isClaudeCreditsMessage(message) ? new CodedError("claude_credits", message) : new Error(message);

/** Streaming: tempo massimo senza alcuna riga dalla CLI (vedi STREAM_IDLE_MS in openai-compat.ts). */
const STREAM_IDLE_MS = 20_000;

// Cartella vuota come cwd: Claude non vede file di progetto.
const SANDBOX_DIR = mkdtempSync(join(tmpdir(), "conclave-"));
const TIMEOUT_MS = 240_000;
/** Unici strumenti concessi per la ricerca sul web (inclusi nell'abbonamento). */
const WEB_TOOLS = "WebSearch,WebFetch";

/** Processi `claude` in corso: alla chiusura del motore vanno fermati, o continuano a consumare l'abbonamento. */
const children = new Set<ChildProcess>();
export function killClaudeChildren(): void {
  for (const c of children) c.kill("SIGTERM");
}

/**
 * Chiama Claude Code in modalità non interattiva usando l'abbonamento Pro.
 * Nessun tool, nessun MCP, nessuna impostazione utente: solo testo. Con `webSearch` può usare
 * solo gli strumenti di ricerca e lettura di pagine web (niente file, niente comandi).
 */
export function chatClaude(model: string, req: ChatRequest): Promise<ChatResult> {
  const started = Date.now();
  const env = { ...process.env };
  // Se fosse impostata una API key, Claude Code la userebbe al posto dell'abbonamento.
  delete env.ANTHROPIC_API_KEY;
  // Claude è un processo esterno: non gli servono le chiavi degli altri provider (da .env, dall'app o con il
  // nome scelto in models.json), altri segreti (`*_KEY`, `*_TOKEN`) né le variabili del motore. Restano quelle
  // di Claude stesso (CLAUDE_CODE_*, ANTHROPIC_AUTH_TOKEN, AWS_* per Bedrock) e quelle normali (PATH, HOME…).
  const providerKeys = new Set(Object.values(config.providers).map((p) => p.keyEnv));
  for (const k of Object.keys(env)) {
    // Credenziali di Claude Code stesso (abbonamento, gateway, Bedrock): toglierle lo romperebbe.
    if (k.startsWith("CLAUDE_CODE_") || k.startsWith("AWS_") || k === "ANTHROPIC_AUTH_TOKEN") continue;
    if (/_KEY$|_TOKEN$/.test(k) || k.startsWith("COUNCIL_") || appKeyNames.includes(k) || providerKeys.has(k)) delete env[k];
  }

  // Streaming (`stream-json` con i pezzi del messaggio): eventi `stream_event` con i `content_block_delta`
  // dell'API, poi la riga finale `result`, che resta l'unica fonte del testo definitivo. La ricerca sul web
  // resta in `json`: con gli strumenti la CLI tace a lungo tra una pagina e l'altra.
  const streaming = !!req.onText && !req.webSearch;
  const args = [
    "-p",
    ...(streaming ? ["--output-format", "stream-json", "--verbose", "--include-partial-messages"] : ["--output-format", "json"]),
    ...(req.webSearch
      ? ["--tools", WEB_TOOLS, "--allowedTools", WEB_TOOLS]
      : ["--tools", ""]),
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--system-prompt", req.system,
    "--model", model,
  ];

  return new Promise((resolve, reject) => {
    // Già annullato (dibattito fermato prima di arrivare qui): `claude` non parte, l'abbonamento non si consuma.
    if (req.signal?.aborted) return reject(req.signal.reason ?? Object.assign(new Error("annullato"), { name: "AbortError" }));
    const child = spawn("claude", args, { cwd: SANDBOX_DIR, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    let stalled = false;
    // Streaming: righe JSON lette finora, testo del messaggio in corso, esito finale (riga `result`).
    let pending = "";
    let text = "";
    let shown = false;
    let final: { result?: string; is_error?: boolean; stop_reason?: unknown } | undefined;
    // Limite di token in uscita: `stop_reason: "max_tokens"` nel `message_delta` dell'API (streaming) o nella riga finale.
    let maxTokens = false;
    const idleMs = req.idleMs ?? STREAM_IDLE_MS;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      if (!streaming) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { stalled = true; child.kill("SIGTERM"); }, idleMs);
    };
    const line = (l: string) => {
      if (!l.trim()) return;
      let j: any;
      try { j = JSON.parse(l); } catch { return; }
      // Riga finale; senza `type` è il formato `json` (una CLI che ignora lo streaming).
      if (j?.type === "result" || (j && j.type === undefined && "result" in j)) { final = j; return; }
      const ev = j?.type === "stream_event" ? j.event : undefined;
      // Un messaggio nuovo dell'assistente riparte da capo (succede solo con gli strumenti).
      if (ev?.type === "message_start") { maxTokens = false; if (text) { text = ""; req.onText!("", model); } }
      if (ev?.type === "message_delta" && ev.delta?.stop_reason) maxTokens = ev.delta.stop_reason === "max_tokens";
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        text += ev.delta.text;
        const vis = text.trimStart();
        if (vis) { shown = true; req.onText!(vis, model); }
      }
    };
    // Testo e non Buffer: un carattere accentato a cavallo di due pezzi non diventa "�".
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    children.add(child);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, TIMEOUT_MS);
    const onAbort = () => child.kill("SIGTERM");
    req.signal?.addEventListener("abort", onAbort, { once: true });
    touch();

    child.stdout.on("data", (d) => {
      touch();
      if (!streaming) { out += d; return; }
      pending += d;
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) { line(pending.slice(0, nl)); pending = pending.slice(nl + 1); }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      clearTimeout(idleTimer);
      children.delete(child);
      reject(new CodedError("claude_unavailable", `claude non avviabile: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(idleTimer);
      children.delete(child);
      req.signal?.removeEventListener("abort", onAbort);
      if (streaming) line(pending);
      const fail = (e: Error) => { if (shown) req.onText!("", model); reject(e); };
      // Fermato da noi: l'output vuoto non è un errore di Claude ma un tempo scaduto.
      if (timedOut) return fail(Object.assign(new Error(`Claude: nessuna risposta entro ${TIMEOUT_MS / 1000} s`), { name: "TimeoutError" }));
      if (stalled && !req.signal?.aborted) return fail(new CodedError("timeout", `Claude: nessun testo da ${Math.round(idleMs / 1000)} s`, "StallError"));
      try {
        const j = streaming ? final : (JSON.parse(out) as { result?: string; is_error?: boolean; stop_reason?: unknown });
        if (!j) {
          // Flusso finito senza la riga `result`: se era già arrivato del testo, la risposta è interrotta.
          if (text) return fail(new CodedError("interrupted", `Claude: risposta interrotta (exit ${code})`));
          throw new Error("nessun esito");
        }
        if (j.is_error || typeof j.result !== "string") {
          fail(claudeError(`Claude: ${redact(String(j.result ?? "errore sconosciuto").slice(0, 300))}`));
          return;
        }
        const truncated = maxTokens || j.stop_reason === "max_tokens";
        resolve({ text: j.result.trim() + (truncated ? TRUNCATION_NOTE : ""), ms: Date.now() - started, truncated });
      } catch {
        fail(claudeError(`Claude (exit ${code}): ${redact((err || out || pending).slice(0, 300)) || "nessun output"}`));
      }
    });
    // Se claude esce prima di leggere tutto il prompt (annullamento, timeout, errore d'avvio)
    // la scrittura dà EPIPE: l'esito si gestisce già in "close", qui va solo evitato il crash.
    child.stdin.on("error", () => {});
    child.stdin.end(req.user);
  });
}
