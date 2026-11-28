// Claude CLI: con il segnale già annullato `claude` non parte; il figlio non eredita chiavi e token.
// Usa una finta `claude` nel PATH, mai quella vera.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "council-unit-claude-"));
const marker = join(dir, "avviata");
const envOut = join(dir, "env.json");
// La finta CLI segna di essere partita e salva i nomi delle variabili che ha ricevuto.
writeFileSync(join(dir, "claude"), `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");
require("node:fs").writeFileSync(${JSON.stringify(envOut)}, JSON.stringify(Object.keys(process.env)));
// Modi scelti dal testo del prompt: risposta troncata (streaming o json) ed errore che chiede crediti separati.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const out = (j) => process.stdout.write(JSON.stringify(j) + "\\n");
  const streaming = process.argv.includes("stream-json");
  if (input.includes("CREDITS")) {
    out({ type: "result", is_error: true, result: "Claude Code programmatic usage (claude -p) now requires Agent SDK credits. Purchase credits or upgrade your plan at claude.ai/settings/billing." });
    process.exit(1);
  }
  if (input.includes("MAXTOK") && streaming) {
    out({ type: "stream_event", event: { type: "message_start" } });
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Risposta lunga" } } });
    out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "max_tokens" } } });
    out({ type: "result", result: "Risposta lunga", is_error: false });
    return;
  }
  if (input.includes("MAXTOK")) return out({ result: "Risposta lunga", stop_reason: "max_tokens" });
  if (input.includes("QUOTE") && streaming) {
    // Risposta completa che finisce citando l'avviso: non è troncata.
    const t = "Una risposta finiva con […risposta troncata dal limite di lunghezza]";
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
    out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } });
    out({ type: "result", result: t, is_error: false, stop_reason: "end_turn" });
    return;
  }
  out({ result: "ok" });
});
`);
chmodSync(join(dir, "claude"), 0o755);
process.env.COUNCIL_DATA = dir;
process.env.PATH = `${dir}:${process.env.PATH}`;
const { chatClaude } = await import("../../src/adapters/claude-cli.ts");
const { config } = await import("../../src/config.ts");
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("segnale già annullato: claude non viene avviato", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(chatClaude("sonnet", { system: "s", user: "u", signal: ac.signal }), (e: Error) => e.name === "AbortError");
  // Margine per un eventuale processo partito comunque.
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(existsSync(marker), false, "la finta claude è partita");
});

test("ambiente del figlio: niente *_KEY, *_TOKEN, keyEnv dei provider né COUNCIL_*; PATH e HOME restano", async () => {
  const provKey = Object.values(config.providers)[0]?.keyEnv;
  const extra: Record<string, string> = {
    SOME_SERVICE_KEY: "x", GH_TOKEN: "x", OTHER_API_KEY: "x", COUNCIL_FOO: "x", CLAUDE_CODE_OAUTH_TOKEN: "x", ANTHROPIC_AUTH_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "x",
    ...(provKey ? { [provKey]: "x" } : {}),
  };
  Object.assign(process.env, extra);
  try {
    const r = await chatClaude("sonnet", { system: "s", user: "u" });
    assert.equal(r.text, "ok");
    const names: string[] = JSON.parse(readFileSync(envOut, "utf8"));
    const leaked = names.filter((k) => /_KEY$|_TOKEN$|^COUNCIL_/.test(k) && !k.startsWith("CLAUDE_CODE_") && !k.startsWith("AWS_") && k !== "ANTHROPIC_AUTH_TOKEN");
    assert.deepEqual(leaked, []);
    if (provKey) assert.ok(!names.includes(provKey));
    assert.ok(names.includes("PATH") && names.includes("HOME"));
    assert.ok(names.includes("CLAUDE_CODE_OAUTH_TOKEN"), "le variabili di Claude stesso restano");
    assert.ok(names.includes("ANTHROPIC_AUTH_TOKEN") && names.includes("AWS_SECRET_ACCESS_KEY"), "gateway e Bedrock restano");
  } finally {
    for (const k of Object.keys(extra)) delete process.env[k];
  }
});

test("troncatura dalla CLI: stop_reason max_tokens (streaming e json) → truncated e avviso in fondo", async () => {
  const mark = "[…risposta troncata dal limite di lunghezza]";
  const streamed = await chatClaude("sonnet", { system: "s", user: "MAXTOK", onText: () => {} });
  assert.equal(streamed.truncated, true);
  assert.ok(streamed.text.endsWith(mark));
  const whole = await chatClaude("sonnet", { system: "s", user: "MAXTOK" });
  assert.equal(whole.truncated, true);
  assert.ok(whole.text.endsWith(mark));
  // Chi cita l'avviso senza essere troncato non lo è.
  const quoted = await chatClaude("sonnet", { system: "s", user: "QUOTE", onText: () => {} });
  assert.equal(!!quoted.truncated, false);
  const plain = await chatClaude("sonnet", { system: "s", user: "u" });
  assert.equal(!!plain.truncated, false);
});

test("Claude che chiede crediti separati per claude -p: codice claude_credits", async () => {
  await assert.rejects(chatClaude("sonnet", { system: "s", user: "CREDITS" }), (e: Error & { code?: string }) => e.code === "claude_credits");
});
