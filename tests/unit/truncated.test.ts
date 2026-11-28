// Troncatura dall'adattatore OpenAI-compat: `finish_reason: "length"` → `truncated` nel risultato (risposta intera e
// streaming), con l'avviso in fondo al testo per chi legge. Una risposta completa che cita l'avviso non è troncata.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "council-unit-trunc-"));
process.env.COUNCIL_DATA = dir;
process.env.TRUNC_UNIT_KEY = "x".repeat(16);
const { chatOpenAI } = await import("../../src/adapters/openai-compat.ts");
const { TRUNCATION_MARK } = await import("../../src/debate/prompts.ts");

const QUOTE = `Una risposta finiva con «${TRUNCATION_MARK}»\n\n${TRUNCATION_MARK}`;
// Modello = esito: "length" taglia, "quote" finisce citando l'avviso ma completa.
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const j = JSON.parse(body);
    const finish = j.model === "length" ? "length" : "stop";
    const text = j.model === "quote" ? QUOTE : "Risposta di prova";
    if (j.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: finish }] }));
  });
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const p = { name: "Prova", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, keyEnv: "TRUNC_UNIT_KEY" };
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

for (const streaming of [false, true]) {
  const how = streaming ? "streaming" : "risposta intera";
  const req = { system: "s", user: "u", ...(streaming ? { onText: () => {} } : {}) };

  test(`finish_reason length (${how}): truncated e avviso in fondo`, async () => {
    const r = await chatOpenAI(p, ["length"], req);
    assert.equal(r.truncated, true);
    assert.ok(r.text.endsWith(TRUNCATION_MARK));
  });

  test(`risposta completa che finisce citando l'avviso (${how}): non troncata`, async () => {
    const r = await chatOpenAI(p, ["quote"], req);
    assert.equal(r.truncated, false);
    assert.ok(r.text.endsWith(TRUNCATION_MARK));
    const ok = await chatOpenAI(p, ["ok"], req);
    assert.equal(ok.truncated, false);
  });
}
