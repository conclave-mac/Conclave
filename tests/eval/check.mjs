// Correttore del banco di valutazione: verifica una risposta contro il criterio di una domanda.
// Funzioni pure, senza dipendenze: le usano run.mjs e il modello finto (oracle.mjs).

/** Spazi non separabili (anche quello stretto) usati come separatori delle migliaia. */
const NBSP = String.fromCharCode(0xa0, 0x202f);
const NBSP_RE = new RegExp(`[${NBSP}]`, "g");

/** Testo confrontabile: minuscolo, senza accenti né enfasi Markdown, spazi non separabili normali. */
export function normalize(text) {
  return String(text ?? "")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[*_`]/g, "")
    .replace(NBSP_RE, " ")
    .toLowerCase();
}

/**
 * Numeri scritti in un testo, nell'ordine, con le convenzioni italiana e inglese:
 * «1.157,63» e «1,157.63» → 1157.63; «0,05» → 0.05; «1.609» e «1,609» → 1609 (tre cifre dopo un solo separatore,
 * parte intera diversa da 0); «2/3» resta due numeri. Il segno meno conta solo attaccato alla cifra.
 */
export function numbersIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/(?<![\w.,])-?\d+(?:[.,]\d{3})*(?:[.,]\d+)?/g)) {
    let s = m[0];
    const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      const dec = lastDot > lastComma ? "." : ",";
      s = s.split(dec === "." ? "," : ".").join("").replace(",", ".");
    } else if (lastDot >= 0 || lastComma >= 0) {
      const sep = lastDot >= 0 ? "." : ",";
      const parts = s.split(sep);
      const thousands = parts.length > 2 || (parts[1].length === 3 && !/^-?0$/.test(parts[0]));
      s = thousands ? parts.join("") : parts.join(".");
    }
    const n = Number(s);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Parte della risposta da correggere: la sezione «## Risposta» del verdetto (o «## Answer»), altrimenti
 * tutto il testo. Senza questa scelta le sezioni sul dibattito citerebbero anche le risposte sbagliate.
 */
export function answerSection(text) {
  const t = String(text ?? "");
  const m = t.match(/^#{1,3}[ \t]*(?:Risposta|Answer|Respuesta|Réponse|Antwort)[ \t]*\n([\s\S]*?)(?=^#{1,3}[ \t]|(?![\s\S]))/m);
  return m ? m[1].trim() : t.trim();
}

/** Primi caratteri in cui cercare un numero: il prompt chiede la risposta diretta in apertura. */
export const NUMBER_WINDOW = 300;

const re = (p) => new RegExp(p, "iu");

/** true se `text` soddisfa il criterio `check` (vedi questions.json). Criterio sconosciuto → eccezione. */
export function isCorrect(check, text) {
  const t = normalize(text);
  const not = check?.not && re(check.not).test(t);
  switch (check?.type) {
    case "number": {
      const tol = check.tol ?? 0;
      return !not && numbersIn(t.slice(0, NUMBER_WINDOW)).some((n) => Math.abs(n - check.value) <= tol + 1e-9);
    }
    case "regex": return !not && re(check.pattern).test(t);
    case "all": return !not && check.patterns.every((p) => re(p).test(t));
    case "any": return !not && check.patterns.some((p) => re(p).test(t));
    default: throw new Error(`criterio sconosciuto: ${JSON.stringify(check)}`);
  }
}

export const KINDS = ["fatto-datato", "fatto", "calcolo", "trappola", "ambigua"];

/** Errori di forma del file delle domande (vuoto = valido); i testi di prova devono dare giusto/sbagliato. */
export function validateQuestions(list) {
  const errors = [];
  if (!Array.isArray(list) || !list.length) return ["questions.json: serve un array non vuoto"];
  const seen = new Set();
  for (const q of list) {
    const where = `domanda ${q?.id ?? "?"}`;
    if (typeof q?.id !== "string" || !/^[a-z0-9-]+$/.test(q.id)) errors.push(`${where}: id mancante o non valido`);
    else if (seen.has(q.id)) errors.push(`${where}: id duplicato`);
    seen.add(q?.id);
    if (!KINDS.includes(q?.kind)) errors.push(`${where}: kind non valido`);
    if (typeof q?.question !== "string" || q.question.length < 5) errors.push(`${where}: question mancante`);
    if (q?.kind === "fatto-datato" && !/\b(19|20)\d{2}\b/.test(q.question)) errors.push(`${where}: fatto datato senza data nella domanda`);
    if (typeof q?.answer !== "string") errors.push(`${where}: answer (risposta attesa leggibile) mancante`);
    try {
      if (!isCorrect(q.check, q.mock?.right ?? "")) errors.push(`${where}: mock.right non supera il criterio`);
      if (isCorrect(q.check, q.mock?.wrong ?? "")) errors.push(`${where}: mock.wrong supera il criterio`);
    } catch (e) { errors.push(`${where}: ${e.message}`); }
  }
  return errors;
}
