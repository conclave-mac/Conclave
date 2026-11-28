// Controllo dei modelli: un errore imprevisto non lascia la voce in "checking" (health.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "council-unit-health-"));
process.env.COUNCIL_DATA = dir;
const { checkGuarded, getHealth } = await import("../../src/health.ts");
test.after(() => rmSync(dir, { recursive: true, force: true }));

const voice = { id: "guard-test", label: "Prova", kind: "openai" as const, provider: "x", model: "m" };

test("checkGuarded: eccezione → down con nota, chiavi mascherate, nessun rifiuto", async () => {
  await checkGuarded(voice, async () => { throw new Error("catalogo esploso con sk-abcdefghijklmnopqrstuvwxyz0123"); });
  const h = getHealth(voice.id);
  assert.equal(h.status, "down");
  assert.match(h.note ?? "", /controllo non riuscito: catalogo esploso/);
  assert.doesNotMatch(h.note ?? "", /sk-abcdefghijklmnopqrstuvwxyz0123/);
});

test("checkGuarded: un controllo riuscito resta com'è", async () => {
  let called = 0;
  await checkGuarded({ ...voice, id: "guard-ok" }, async () => { called++; });
  assert.equal(called, 1);
  assert.equal(getHealth("guard-ok").status, "unchecked");
});
