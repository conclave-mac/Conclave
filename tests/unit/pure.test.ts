// Test unitari delle funzioni pure del motore: `npm test` (node --test, nessun provider né dati).
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTitle, splitConfidence, detectLanguage, parseChanges } from "../../src/debate/prompts.ts";
import { parseTryAgain, visibleText } from "../../src/adapters/openai-compat.ts";
import { errorCode, CodedError } from "../../src/errors.ts";
import { redact } from "../../src/redact.ts";

test("splitTitle: riga TITOLO in testa", () => {
  const r = splitTitle("TITOLO: Treno o aereo\n\nTesto del verdetto");
  assert.equal(r.title, "Treno o aereo");
  assert.equal(r.verdict, "Testo del verdetto");
});
test("splitTitle: intestazione e grassetto", () => {
  assert.equal(splitTitle("## **TITOLO:** Prova breve\nx").title, "Prova breve");
});
test("splitTitle: TITLE in inglese", () => {
  assert.equal(splitTitle("TITLE: Short title\nbody").title, "Short title");
});
test("splitTitle: senza riga resta tutto verdetto", () => {
  assert.deepEqual(splitTitle("solo testo"), { title: null, verdict: "solo testo" });
});
test("splitTitle: riga oltre i primi 200 caratteri ignorata", () => {
  const t = "x".repeat(250) + "\nTITOLO: tardi";
  assert.equal(splitTitle(t).title, null);
});
test("splitTitle: virgolette e punto finale tolti", () => {
  assert.equal(splitTitle("TITOLO: «Roma o Milano».\nx").title, "Roma o Milano");
});
test("splitTitle: TITOLO vuoto non prende la riga dopo", () => {
  const r = splitTitle("TITOLO:\nRisposta");
  assert.equal(r.title, null);
  assert.equal(r.verdict, "Risposta");
});

test("splitConfidence: alta", () => {
  const r = splitConfidence("AFFIDABILITÀ: alta\n\nVerdetto");
  assert.equal(r.confidence, "alta");
  assert.equal(r.verdict, "Verdetto");
});
test("splitConfidence: tradotta e in grassetto", () => {
  assert.equal(splitConfidence("**CONFIDENCE:** High\n\nx").confidence, "alta");
});
test("splitConfidence: media e bassa", () => {
  assert.equal(splitConfidence("AFFIDABILITA: media\nx").confidence, "media");
  assert.equal(splitConfidence("RELIABILITY: low\nx").confidence, "bassa");
});
test("splitConfidence: valore sconosciuto → null, riga tolta", () => {
  const r = splitConfidence("AFFIDABILITÀ: boh\nresto");
  assert.equal(r.confidence, null);
  assert.equal(r.verdict, "resto");
});
test("splitConfidence: assente", () => {
  assert.deepEqual(splitConfidence("testo"), { confidence: null, verdict: "testo" });
});
test("splitConfidence: frase lunga nel corpo non è la riga macchina", () => {
  const t = "Affidabilità: dipende molto da quanto sono aggiornati i dati di partenza";
  assert.equal(splitConfidence(t).verdict, t);
});

test("detectLanguage: italiano", () => {
  assert.equal(detectLanguage("meglio columbia patagonia o northface"), "italiano");
  assert.equal(detectLanguage("Conviene usare il treno o l'aereo per Roma–Milano?"), "italiano");
});
test("detectLanguage: inglese", () => {
  assert.equal(detectLanguage("What is the best laptop for coding under 1000 dollars?"), "inglese");
});
test("detectLanguage: spagnolo, francese, tedesco", () => {
  assert.equal(detectLanguage("¿Cuál es el mejor portátil para programar?"), "spagnolo");
  assert.equal(detectLanguage("Quel est le meilleur ordinateur pour coder ?"), "francese");
  assert.equal(detectLanguage("Welche ist die beste Kamera für Anfänger?"), "tedesco");
});
test("detectLanguage: solo nomi → null", () => {
  assert.equal(detectLanguage("iPhone 17 vs Pixel 10"), null);
});
test("detectLanguage: ripiego sul secondo testo", () => {
  assert.equal(detectLanguage("iPhone 17 vs Pixel 10", "Meglio il Pixel per le foto, ma l'iPhone dura di più ed è più fluido."), "italiano");
});

test("parseChanges: valori italiani", () => {
  assert.equal(parseChanges("...\nCAMBIAMENTI: nessuno"), "nessuno");
  assert.equal(parseChanges("CAMBIAMENTI: **sostanziali**"), "sostanziali");
  assert.equal(parseChanges("cambiamenti: Minori"), "minori");
});
test("parseChanges: forma inglese", () => {
  assert.equal(parseChanges("CHANGES: none"), "nessuno");
  assert.equal(parseChanges("CHANGES: substantial"), "sostanziali");
});
test("parseChanges: assente → ?", () => {
  assert.equal(parseChanges("niente riga"), "?");
});

test("parseTryAgain: secondi, minuti, millisecondi", () => {
  assert.equal(parseTryAgain("Please try again in 22.5s."), 22.5);
  assert.equal(parseTryAgain("try again in 1m2.5s"), 62.5);
  assert.equal(parseTryAgain("try again in 750ms"), 0.75);
  assert.equal(parseTryAgain("try again in 1h2m3s"), 3723);
});
test("parseTryAgain: assente → 0", () => {
  assert.equal(parseTryAgain("Internal server error"), 0);
});

test("errorCode: codice esplicito vince", () => {
  assert.equal(errorCode(new CodedError("timeout", "HTTP 429: x")), "timeout");
});
test("errorCode: classificazione dal testo", () => {
  assert.equal(errorCode(new Error("HTTP 401: Incorrect API key")), "invalid_key");
  assert.equal(errorCode(new Error("HTTP 429: Request too large for model")), "too_long");
  assert.equal(errorCode(new Error("HTTP 429: limit per day reached (RPD)")), "quota_exhausted");
  assert.equal(errorCode(new Error("HTTP 429: You exceeded your current quota, please retry in 20s")), "rate_limited");
  assert.equal(errorCode(new Error("You exceeded your current quota, please check your plan")), "quota_exhausted");
  assert.equal(errorCode(new Error("HTTP 404: model not found")), "model_retired");
  assert.equal(errorCode(new Error("chiave GROQ_API_KEY mancante")), "missing_key");
  assert.equal(errorCode(new Error("fetch failed ECONNREFUSED")), "network");
  assert.equal(errorCode(new Error("nessuna risposta entro 90 s")), "timeout");
  assert.equal(errorCode(new Error("HTTP 418: teapot")), "provider_error");
  assert.equal(errorCode("qualcosa di strano"), "unknown");
});

test("visibleText: ragionamento tolto, anche non chiuso", () => {
  assert.equal(visibleText("<think>pensiero</think>Risposta"), "Risposta");
  assert.equal(visibleText("Inizio<think>a metà"), "Inizio");
  assert.equal(visibleText("Testo <thi"), "Testo ");
});
test("visibleText: caratteri tipografici normalizzati", () => {
  assert.equal(visibleText("anno‑2026 %"), "anno-2026 %");
});

test("redact: formati di chiave noti", () => {
  assert.equal(redact("key AIzaSyChaos0123456789abcdefghijklmnopq end"), "key [chiave nascosta] end");
  assert.equal(redact("gsk_abcdefghijklmnopqrstuvwxyz"), "[chiave nascosta]");
  assert.equal(redact("Authorization: Bearer abcdefghijklmnop1234"), "Authorization: Bearer [chiave nascosta]");
});
test("redact: id organizzazione e base64 lunghi", () => {
  assert.equal(redact("org_01abcdefghijklmnop"), "org_[nascosto]");
  assert.equal(redact("x " + "A".repeat(300)), "x […dati base64 omessi]");
});
test("redact: valori segreti dell'ambiente", () => {
  process.env.UNIT_TEST_API_KEY = "valore-segreto-unit-123";
  try { assert.equal(redact("errore con valore-segreto-unit-123"), "errore con [chiave nascosta]"); }
  finally { delete process.env.UNIT_TEST_API_KEY; }
});
