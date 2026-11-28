// Modelli finti del banco di valutazione (solo prova di struttura, mai provider veri).
// Il mock della suite chaos (tests/chaos/mock-provider.mjs) li usa per i modelli "eval-*"; run.mjs usa le stesse
// regole per calcolare i risultati attesi e controllare il conteggio da capo a fondo.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let cache = null;
export const questions = () => (cache ??= JSON.parse(readFileSync(join(HERE, "questions.json"), "utf8")));

/** Etichetta inserita nelle domande in modalità finta: «[eval:<id>]». */
export const tagOf = (id) => `[eval:${id}]`;
export const idOf = (text) => String(text ?? "").match(/\[eval:([a-z0-9-]+)\]/)?.[1] ?? null;

/** Numero stabile per domanda: decide in modo ripetibile chi sbaglia. */
export function hash(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** Membri finti: chi risponde giusto e chi salta il round di critica (errore 500). */
export const MEMBERS = {
  "eval-right": { right: () => true, failsCritique: () => false },
  "eval-half": { right: (h) => h % 2 === 0, failsCritique: (h) => h % 7 === 0 },
  "eval-wrong": { right: (h) => h % 4 === 0, failsCritique: () => false },
};
export const JUDGE = "eval-judge";
export const MODELS = [...Object.keys(MEMBERS), JUDGE];
/** Verdetto finto: giusto salvo una domanda su cinque; affidabilità secondo una regola fissa. */
export const judgeRight = (h) => h % 5 !== 0;
export const judgeConfidence = (h) => (judgeRight(h) ? (h % 3 === 0 ? "media" : "alta") : h % 2 ? "bassa" : "media");

/**
 * Risposta di un modello finto: `null` = errore 500 (round saltato). `phase`: initial, critique, revise, final,
 * verdict. Domanda senza etichetta (es. prova d'avvio) → «OK».
 */
export function reply(model, phase, user) {
  const id = idOf(user);
  const q = id && questions().find((x) => x.id === id);
  if (!q) return "OK";
  const h = hash(id);
  if (model === JUDGE) {
    const text = judgeRight(h) ? q.mock.right : q.mock.wrong;
    return `TITOLO: Prova ${id}\nAFFIDABILITÀ: ${judgeConfidence(h)}\n\n## Su cosa concordano\n- A e B: prova.\n## Errori emersi nel dibattito\n- Nessuno.\n## Disaccordi irrisolti\n- Nessuno.\n\nVERDETTO\n\n## Risposta\n${text}\n\n## Perché questa risposta\nProva di struttura.`;
  }
  const m = MEMBERS[model];
  if (!m) return "OK";
  if (phase === "critique" && m.failsCritique(h)) return null;
  let text = m.right(h) ? q.mock.right : q.mock.wrong;
  if (phase === "revise") text += "\n\nCAMBIAMENTI: nessuno";
  if (phase === "final") text += "\n\nFIDUCIA: media";
  return text;
}
