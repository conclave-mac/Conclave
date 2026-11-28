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
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ result: "ok" })));
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
    SOME_SERVICE_KEY: "x", GH_TOKEN: "x", OTHER_API_KEY: "x", COUNCIL_FOO: "x", CLAUDE_CODE_OAUTH_TOKEN: "x",
    ...(provKey ? { [provKey]: "x" } : {}),
  };
  Object.assign(process.env, extra);
  try {
    const r = await chatClaude("sonnet", { system: "s", user: "u" });
    assert.equal(r.text, "ok");
    const names: string[] = JSON.parse(readFileSync(envOut, "utf8"));
    const leaked = names.filter((k) => /_KEY$|_TOKEN$|^COUNCIL_/.test(k) && !k.startsWith("CLAUDE_CODE_"));
    assert.deepEqual(leaked, []);
    if (provKey) assert.ok(!names.includes(provKey));
    assert.ok(names.includes("PATH") && names.includes("HOME"));
    assert.ok(names.includes("CLAUDE_CODE_OAUTH_TOKEN"), "le variabili di Claude stesso restano");
  } finally {
    for (const k of Object.keys(extra)) delete process.env[k];
  }
});
