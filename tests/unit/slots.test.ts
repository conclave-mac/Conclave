// Richieste in volo per provider (P2.1a).
import { test } from "node:test";
import assert from "node:assert/strict";
import { providerSlots, acquireSlot, PROVIDER_SLOTS } from "../../src/adapters/openai-compat.ts";

const prov = (baseUrl: string, extra: object = {}) => ({ name: "x", baseUrl, keyEnv: "X_KEY", ...extra }) as any;

test("providerSlots: remoto limitato, locale libero, valore esplicito", () => {
  assert.equal(providerSlots(prov("https://api.groq.com/openai/v1")), PROVIDER_SLOTS);
  assert.equal(providerSlots(prov("http://127.0.0.1:4999/v1")), Infinity);
  assert.equal(providerSlots(prov("http://localhost:11434/v1")), Infinity);
  assert.equal(providerSlots(prov("http://127.0.0.1:4999/v1", { maxConcurrent: 2 })), 2);
  assert.equal(providerSlots(prov("https://x.example/v1", { maxConcurrent: 0 })), PROVIDER_SLOTS);
});

test("acquireSlot: al massimo N in volo, il posto passa a chi aspetta", async () => {
  const p = prov("https://slots.example/v1", { maxConcurrent: 2 });
  const r1 = await acquireSlot(p), r2 = await acquireSlot(p);
  let third = false;
  const t = acquireSlot(p).then((r) => { third = true; return r; });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(third, false);
  r1();
  const r3 = await t;
  assert.equal(third, true);
  r1(); // doppio rilascio ignorato
  let fourth = false;
  const t4 = acquireSlot(p).then((r) => { fourth = true; return r; });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(fourth, false, "il doppio rilascio non deve liberare un posto");
  r2(); (await t4)(); r3();
});

test("acquireSlot: l'attesa si interrompe col segnale", async () => {
  const p = prov("https://slots2.example/v1", { maxConcurrent: 1 });
  const r1 = await acquireSlot(p);
  const ac = new AbortController();
  const waiting = acquireSlot(p, ac.signal);
  ac.abort(new Error("annullato"));
  await assert.rejects(waiting, /annullato/);
  r1();
  // Chi ha rinunciato non resta in coda: il posto è subito libero.
  (await acquireSlot(p))();
});

test("withBudget: il tempo si ferma mentre l'intervento è in coda", async () => {
  const { withBudget } = await import("../../src/debate/orchestrator.ts");
  const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  const ok = await withBudget(100, new AbortController().signal, async (budget, hold) => {
    hold(true); await wait(150); hold(false); // 150 ms in coda: non contano
    await wait(60);
    return budget.aborted ? "scaduto" : "in tempo";
  });
  assert.equal(ok, "in tempo");
  await assert.rejects(
    withBudget(80, new AbortController().signal, (budget) => new Promise((_, ko) => budget.addEventListener("abort", () => ko(budget.reason)))),
    (e: Error) => /entro 0 s|entro \d+ s/.test(e.message) && (e as { code?: string }).code === "timeout",
  );
});

test("acquireSlot: avvisa quando si mette in coda e quando ha il posto", async () => {
  const p = { name: "x", baseUrl: "https://coda.example/v1", keyEnv: "CODA_KEY", maxConcurrent: 1 } as never;
  const seen: boolean[] = [];
  const r1 = await acquireSlot(p, undefined, (q) => seen.push(q));
  const t = acquireSlot(p, undefined, (q) => seen.push(q));
  await new Promise((ok) => setTimeout(ok, 10));
  r1();
  (await t)();
  assert.deepEqual(seen, [true, false]);
});
