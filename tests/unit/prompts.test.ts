// Testo dei prompt del dibattito: lettera propria e intestazioni delle critiche (P0.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { critiquePrompt, revisePrompt, finalPrompt, judgePrompt } from "../../src/debate/prompts.ts";

const others = [{ label: "A", text: "risposta di A" }, { label: "C", text: "risposta di C" }];
const critiques = [{ label: "A", text: "B sbaglia la cifra" }, { label: "B", text: "A dimentica il costo" }];

test("critica: il membro sa di essere la Risposta B", () => {
  const p = critiquePrompt("Domanda?", "mia", others, null, undefined, "B");
  assert.match(p, /LA TUA RISPOSTA INIZIALE \(sei la Risposta B\):/);
  assert.match(p, /### Risposta A\n/);
  assert.ok(p.includes("Round 1"));
});
test("revisione: lettera propria e critiche intestate con l'autore", () => {
  const p = revisePrompt("Domanda?", "mia", critiques, undefined, "B");
  assert.match(p, /sei la Risposta B/);
  assert.match(p, /ti riguardano i punti rivolti alla Risposta B/);
  assert.match(p, /### Critica scritta da A\n/);
  assert.match(p, /### Critica scritta da B \(la tua\)\n/);
  assert.ok(!p.includes("### Risposta A"), "le critiche non sono intestate come risposte");
  assert.ok(p.includes("Round 2") && p.includes("CAMBIAMENTI:"));
});
test("posizione finale: lettera propria", () => {
  const p = finalPrompt("Domanda?", "mia", others, undefined, "B");
  assert.match(p, /LA TUA RISPOSTA RIVISTA \(sei la Risposta B\):/);
  assert.ok(p.includes("Round 3"));
});
test("senza lettera i prompt restano validi", () => {
  assert.match(revisePrompt("Domanda?", "mia", critiques), /LA TUA RISPOSTA INIZIALE:\n/);
});
test("giudice: critiche intestate con l'autore", () => {
  const p = judgePrompt("Domanda?", others, critiques);
  assert.match(p, /### Critica scritta da A\n/);
  assert.ok(!p.includes("(la tua)"));
  assert.ok(p.includes("POSIZIONI FINALI DEI MEMBRI"));
});
