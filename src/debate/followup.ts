// Chat continua: ricostruisce dal DB la conversazione che precede un turno ≥ 1
// (domanda originale, allegati, ricerca, verdetto del turno 0 e scambi successivi).
import { getConversationRows, getAttachments } from "../db.ts";
import { ROLES, type Conversation, type Exchange, type Role } from "./prompts.ts";

/** Messaggi che non sono risposte di un partecipante: note, metadati, domande, ricerca, giudice. */
const notAnswer = (id: string) => id.startsWith("_") || id.startsWith("research") || id.startsWith("judge:");

/** Conversazione dei turni 0…turn-1 della discussione `debateId`, con la domanda originale `question`. */
export function buildConversation(debateId: number, question: string, turn: number): Conversation {
  const rows = getConversationRows(debateId).filter((r) => r.turn < turn);
  // Immagini vere solo della domanda iniziale: quelle dei turni intermedi restano come testo (OCR), altrimenti
  // si rimanderebbero tutte a ogni fase e turno. Quelle del turno corrente le aggiunge chi chiama.
  const attachments = getAttachments(debateId)
    .filter((a) => a.turn < turn)
    .map(({ name, kind, text, imageData, turn: t }) => ({ name, kind, text, ...(imageData && t === 0 ? { imageData } : {}) }));
  const research = rows
    .filter((r) => r.phase === "research" && r.content && r.model_id.startsWith("research:"))
    .map((r) => ({ text: r.content!, date: r.created_at.slice(0, 10) }));

  const turn0 = rows.filter((r) => r.turn === 0);
  const verdict = turn0.filter((r) => r.phase === "verdict" && r.content).at(-1)?.content ?? null;
  // Senza verdetto: l'ultima posizione di ogni partecipante (le fasi sono salvate in ordine).
  const last = new Map<string, string>();
  for (const r of turn0) if (r.content && !notAnswer(r.model_id)) last.set(r.model_id, r.content);

  const exchanges: Exchange[] = [];
  for (let t = 1; t < turn; t++) {
    const rs = rows.filter((r) => r.turn === t);
    const q = rs.find((r) => r.model_id === "_user")?.content;
    if (!q) continue;
    let council = false;
    try { council = JSON.parse(rs.find((r) => r.model_id === "_meta" && r.phase === "turn")?.content ?? "{}").mode === "council"; } catch { /* valore rovinato */ }
    const answer = rs.filter((r) => (r.phase === "answer" || r.phase === "verdict") && r.content).at(-1)?.content ?? null;
    exchanges.push({ question: q, answer, council });
  }
  return { question, attachments, research, verdict, answers: verdict ? [] : [...last.values()], exchanges };
}

/**
 * Ruoli della discussione `{idVoce: ruolo}`: quelli dell'ultimo dibattito (originale o consiglio rilanciato),
 * letti dai partecipanti salvati in `_meta`. Valori rovinati o sconosciuti si ignorano.
 */
export function discussionRoles(debateId: number): Record<string, Role> {
  const rows = getConversationRows(debateId);
  // Un consiglio rilanciato con 0 round non salva ruoli (lì non agiscono): non deve cancellare quelli di prima.
  const roundsOf = (turn: number): number => {
    try { return Number(JSON.parse(rows.find((r) => r.model_id === "_meta" && r.phase === "turn" && r.turn === turn)?.content ?? "{}").rounds ?? 1); }
    catch { return 1; }
  };
  const meta = rows.filter((r) => r.model_id === "_meta" && r.phase === "start" && r.content && (r.turn === 0 || roundsOf(r.turn) >= 1)).at(-1);
  const out: Record<string, Role> = {};
  try {
    const list: unknown = JSON.parse(meta?.content ?? "[]");
    for (const p of Array.isArray(list) ? list : []) {
      if (p && typeof p.id === "string" && (ROLES as readonly unknown[]).includes(p.role)) out[p.id] = p.role as Role;
    }
  } catch { /* valore rovinato: nessun ruolo */ }
  return out;
}
