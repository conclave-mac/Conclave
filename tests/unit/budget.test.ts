// Tetto degli interventi (withBudget): chi sta scrivendo allo scadere può finire, fino al tetto di sicurezza.
// L'orchestratore carica config e DB: si importa con una cartella dati temporanea, mai quella reale.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "council-unit-"));
process.env.COUNCIL_DATA = dir;
const { withBudget } = await import("../../src/debate/orchestrator.ts");
after(() => rmSync(dir, { recursive: true, force: true }));

const never = new AbortController().signal;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** Finto intervento: pezzi di testo ogni `every` ms da `start` ms in poi, `n` pezzi, poi risolve; fermato dal segnale. */
function writer(start: number, every: number, n: number, onEnd?: (progress: (t: string) => void) => void) {
  return (budget: AbortSignal, _hold: (p: boolean) => void, progress: (t: string) => void) => new Promise<string>((ok, ko) => {
    let text = "", timers: ReturnType<typeof setTimeout>[] = [];
    budget.addEventListener("abort", () => { timers.forEach(clearTimeout); ko(budget.reason); }, { once: true });
    for (let i = 0; i < n; i++) timers.push(setTimeout(() => { text += "x"; progress(text); }, start + i * every));
    timers.push(setTimeout(() => (onEnd ? onEnd(progress) : ok(text)), start + n * every));
  });
}

test("withBudget: chi scrive già allo scadere del tetto finisce", async () => {
  const t = await withBudget(100, never, writer(60, 20, 8), 400); // pezzi da 60 a 200 ms, tetto 100
  assert.equal(t, "xxxxxxxx");
});

test("withBudget: senza testo allo scadere del tetto si ferma", async () => {
  const t0 = Date.now();
  await assert.rejects(withBudget(100, never, writer(150, 20, 3), 400), /nessuna risposta entro/);
  assert.ok(Date.now() - t0 < 140);
});

test("withBudget: testo azzerato dopo il tetto (tentativo fallito) = scaduto subito, niente riserva fuori tempo", async () => {
  const t0 = Date.now();
  // Come l'adapter: azzera il testo e lancia l'errore vero del tentativo, che resta quello mostrato.
  await assert.rejects(withBudget(100, never, (b, h, progress) => writer(60, 20, 4, (p) => p(""))(b, h, progress).catch(() => {
    throw new Error("nessun testo dal modello da 20 s");
  }), 1000), /nessun testo dal modello/);
  assert.ok(Date.now() - t0 < 300);
});

test("withBudget: chi scrive senza fine si ferma al tetto di sicurezza", async () => {
  const t0 = Date.now();
  await assert.rejects(withBudget(100, never, writer(20, 10, 1000), 250), /risposta non finita entro/);
  const ms = Date.now() - t0;
  assert.ok(ms >= 240 && ms < 400, `fermato dopo ${ms} ms`);
});

test("withBudget: senza tetto di sicurezza vale il tetto normale anche per chi scrive", async () => {
  await assert.rejects(withBudget(100, never, writer(20, 10, 1000)), /nessuna risposta entro/);
});

test("withBudget: l'attesa in coda non conta in nessuno dei due tetti", async () => {
  const t = await withBudget(100, never, async (budget, hold, progress) => {
    hold(true);
    await sleep(250); // oltre entrambi i tetti, ma in coda
    hold(false);
    if (budget.aborted) throw new Error("scaduto in coda");
    progress("ok");
    return "ok";
  }, 200);
  assert.equal(t, "ok");
});
