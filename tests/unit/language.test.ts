// Lingua dichiarata al giudice (P1.2): riconosciuta giusta o nulla, mai sbagliata.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage } from "../../src/debate/prompts.ts";

const CASES: Record<string, string[]> = {
  italiano: [
    "Conviene usare il treno o l'aereo per Roma–Milano?",
    "Qual è il miglior portatile per programmare sotto i 1000 euro?",
    "Perché il cielo è blu e non verde?",
    "miglior fornetto elettrico sui 20 litri multifunzione massimo 90euro venduto su amazon per fare tipo lasagne patate etc",
    "meglio columbia patagonia o northface",
  ],
  inglese: [
    "What is the best laptop for coding under 1000 dollars?",
    "Should I rent or buy a house in this market?",
    "How does the immune system remember old infections?",
  ],
  spagnolo: [
    "¿Cuál es el mejor portátil para programar?",
    "¿Qué es más barato, el tren o el avión entre Madrid y Barcelona?",
    "Quiero aprender a cocinar pero no tengo tiempo, ¿hay algún método rápido?",
  ],
  portoghese: [
    "Qual é o melhor notebook para programar com menos de 5000 reais?",
    "Vale a pena comprar um carro elétrico em Portugal ou não?",
    "Você acha que os juros vão cair este ano? Isso muda muito o mercado.",
  ],
  francese: [
    "Quel est le meilleur ordinateur pour coder ?",
    "Est-ce que je dois louer ou acheter un appartement à Paris ?",
    "Quelle est la différence entre une assurance vie et un livret A pour les enfants ?",
  ],
  tedesco: [
    "Welche ist die beste Kamera für Anfänger?",
    "Ist es besser, ein Auto zu kaufen oder zu leasen?",
    "Wie kann ich mit dem Rauchen aufhören, ohne zuzunehmen?",
  ],
  olandese: [
    "Wat is de beste laptop voor een student?",
    "Is het beter om een huis te kopen of te huren in Amsterdam?",
    "Hoe kan ik mijn Nederlands verbeteren zonder naar een school te gaan?",
  ],
};

for (const [lang, list] of Object.entries(CASES)) {
  test(`detectLanguage: ${lang}`, () => {
    for (const q of list) assert.equal(detectLanguage(q), lang, q);
  });
}

test("detectLanguage: domande ambigue → null, mai una lingua sbagliata", () => {
  for (const q of ["¿Cómo invertir en bolsa de valores?", "Cuánto cuesta vivir en Madrid de estudiante", "Comment investir en bourse en 2026 ?", "Prix de l'immobilier en France", "iPhone 17 vs Pixel 10", "Patagonia o Northface?", "Tesla Model 3 o Model Y", "BMW X1 vs Audi Q3", "Python e Rust", "PS5 Pro"]) {
    assert.equal(detectLanguage(q), null, q);
  }
});

test("detectLanguage: senza esito nella domanda decide il testo dei membri", () => {
  assert.equal(detectLanguage("iPhone 17 vs Pixel 10", "Meglio il Pixel per le foto, ma l'iPhone dura di più ed è più fluido."), "italiano");
});
