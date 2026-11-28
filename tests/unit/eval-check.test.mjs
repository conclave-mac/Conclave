// Correttore del banco di valutazione (tests/eval/check.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { numbersIn, answerSection, isCorrect, validateQuestions } from "../eval/check.mjs";

test("numeri in formato italiano e inglese", () => {
  assert.deepEqual(numbersIn("1.157,63 € e 1,157.63 $"), [1157.63, 1157.63]);
  assert.deepEqual(numbersIn("0,05 € ovvero 0.05"), [0.05, 0.05]);
  assert.deepEqual(numbersIn("1.609 m, 1,852 m, 299.792.458 m/s"), [1609, 1852, 299792458]);
  assert.deepEqual(numbersIn("probabilità 2/3, 8848,86 m"), [2, 3, 8848.86]);
});

test("si corregge solo la sezione Risposta del verdetto", () => {
  const v = "## Su cosa concordano\n- B diceva 28.\n\n## Risposta\n27 Stati.\n\n## Dove divergono\n| x |";
  assert.equal(answerSection(v), "27 Stati.");
  assert.equal(answerSection("Solo testo."), "Solo testo.");
  assert.ok(isCorrect({ type: "number", value: 27 }, answerSection(v)));
  assert.ok(!isCorrect({ type: "number", value: 28 }, answerSection(v)));
});

test("criteri: accenti ignorati, «not» vince, criterio sconosciuto è un errore", () => {
  assert.ok(isCorrect({ type: "regex", pattern: "\\bnoe\\b" }, "Fu **Noè**, non Mosè."));
  assert.ok(!isCorrect({ type: "regex", pattern: "second", not: "^\\W*prim" }, "Primo, poi secondo."));
  assert.throws(() => isCorrect({ type: "boh" }, "x"));
  assert.ok(validateQuestions([{ id: "x", kind: "calcolo", question: "Quanto fa 1+1?", answer: "2", check: { type: "number", value: 2 }, mock: { right: "2", wrong: "3" } }]).length === 0);
  assert.ok(validateQuestions([{ id: "x", kind: "fatto-datato", question: "Chi governa?", answer: "?", check: { type: "regex", pattern: "a" }, mock: { right: "a", wrong: "a" } }]).length >= 2);
});
