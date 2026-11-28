// Tetto all'attesa in coda che non conta nella fase del verdetto (COUNCIL_QUEUE_CREDIT_MS).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.COUNCIL_QUEUE_CREDIT_MS = "300";
const { firstInChain } = await import("../../src/debate/orchestrator.ts");

test("coda sempre piena: la fase finisce entro tetto + credito, non mai", async () => {
  const started = Date.now();
  const ok = await firstInChain(
    [{ id: "j1" } as any],
    { signal: new AbortController().signal } as any,
    (_m, budget, _progress, onQueued) => new Promise<void>((_res, rej) => {
      onQueued(true);                                   // in coda per sempre
      budget.addEventListener("abort", () => rej(Object.assign(new Error("timeout"), { name: "TimeoutError" })), { once: true });
    }),
    () => {},
    1200,
  );
  const ms = Date.now() - started;
  assert.equal(ok, false);
  assert.ok(ms >= 1400 && ms < 4000, `durata ${ms} ms`);
});
