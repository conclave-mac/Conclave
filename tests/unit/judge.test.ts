// Giudice che ha partecipato (P0.3): catena, prompt di sistema. L'orchestratore carica config e DB:
// si importa con una cartella dati temporanea, mai quella reale.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeSystem, SYSTEM_JUDGE } from "../../src/debate/prompts.ts";

const dir = mkdtempSync(join(tmpdir(), "council-unit-"));
process.env.COUNCIL_DATA = dir;
const { chainOf, isParticipant } = await import("../../src/debate/orchestrator.ts");
after(() => rmSync(dir, { recursive: true, force: true }));

const m = (id: string, kind: "openai" | "claude-cli" = "openai") => ({ id, label: id, kind, model: id }) as any;
const ids = (l: { id: string }[]) => l.map((x) => x.id).join(",");

test("judgeSystem: la frase 'Non hai partecipato' solo se è vero", () => {
  assert.ok(judgeSystem(false).includes("Non hai partecipato al dibattito."));
  assert.ok(!judgeSystem(true).includes("Non hai partecipato"));
  assert.ok(judgeSystem(true).includes("Hai fatto parte anche tu del consiglio"));
  assert.ok(judgeSystem(true).includes("giudice"));
  assert.equal(SYSTEM_JUDGE, judgeSystem(false));
});

test("isParticipant: stesso id o Claude CLI da entrambe le parti", () => {
  assert.ok(isParticipant(m("gemini"), [m("gemini"), m("qwen")]));
  assert.ok(!isParticipant(m("mistral"), [m("gemini")]));
  assert.ok(isParticipant(m("claude-judge", "claude-cli"), [m("claude", "claude-cli")]));
});

test("chainOf: la scelta resta prima, le riserve esterne passano davanti", () => {
  const parts = [m("a"), m("b")];
  // Il giudice predefinito (Claude) non partecipa: viene subito dopo la scelta.
  const chain = chainOf(m("a"), parts, "sonnet", parts);
  assert.equal(chain[0].id, "a");
  assert.equal(chain[1].kind, "claude-cli");
  assert.equal(ids(chain.slice(2)), "b");
});

test("chainOf: Claude partecipante scivola dietro le riserve esterne", () => {
  const parts = [m("claude", "claude-cli"), m("b")];
  const chain = chainOf(m("ext"), [m("b"), m("x")], "sonnet", parts);
  assert.equal(ids(chain), "ext,x,claude,b");
});

test("chainOf: senza partecipanti l'ordine storico non cambia", () => {
  const chain = chainOf(m("a"), [m("b"), m("c")], "sonnet");
  assert.equal(chain[0].id, "a");
  assert.equal(ids(chain.slice(2)), "b,c");
});
