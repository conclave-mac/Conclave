// Cancellazione in una transazione e allegati solo per discussioni esistenti (db.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Cartella dati temporanea prima di caricare db.ts (che apre il database all'import).
const dir = mkdtempSync(join(tmpdir(), "council-unit-db-"));
process.env.COUNCIL_DATA = dir;
const db = await import("../../src/db.ts");
test.after(() => rmSync(dir, { recursive: true, force: true }));

const opts = { rounds: 0, judge: "a", claudeModel: "sonnet" };
const msg = (content: string) => ({ model_id: "a", phase: "initial", content, error: null, ms: 1 });

test("deleteDebate: tutto o niente", () => {
  const id = db.createDebate("domanda", ["a"], opts);
  db.saveMessage(id, msg("risposta"));
  db.saveAttachments(id, [{ name: "n.txt", kind: "text", text: "testo" }]);
  // Un'altra connessione fa fallire l'ultima cancellazione (quella della discussione).
  const other = new DatabaseSync(join(dir, "data", "council.db"));
  other.exec("CREATE TRIGGER no_delete BEFORE DELETE ON debates BEGIN SELECT RAISE(ABORT, 'bloccato dalla prova'); END;");
  try {
    assert.throws(() => db.deleteDebate(id), /bloccato dalla prova/);
    const d = db.getDebate(id);
    assert.ok(d, "la discussione deve restare");
    assert.equal(d!.messages.length, 1, "i messaggi già cancellati devono tornare (rollback)");
    assert.equal(db.getAttachments(id).length, 1, "gli allegati già cancellati devono tornare (rollback)");
  } finally {
    other.exec("DROP TRIGGER no_delete");
    other.close();
  }
  db.deleteDebate(id);
  assert.equal(db.getDebate(id), undefined);
  assert.equal(db.getAttachments(id).length, 0);
});

test("saveAttachments: niente righe orfane per una discussione eliminata", () => {
  const id = db.createDebate("domanda", ["a"], opts);
  db.deleteDebate(id);
  db.saveAttachments(id, [{ name: "n.txt", kind: "text", text: "testo" }, { name: "f.jpg", kind: "image", text: "ocr", imageData: "abc" }]);
  db.saveMessage(id, msg("tardiva"));
  assert.equal(db.getAttachments(id).length, 0);
  const raw = new DatabaseSync(join(dir, "data", "council.db"));
  try {
    const n = raw.prepare("SELECT COUNT(*) AS n FROM attachments WHERE debate_id = ?").get(id) as { n: number };
    assert.equal(Number(n.n), 0);
  } finally { raw.close(); }
});

test("renameDebate: titolo dell'utente che il verdetto non sostituisce, updated_at fermo", () => {
  const id = db.createDebate("domanda", ["a"], opts);
  const before = db.getDebate(id)!.updated_at;
  assert.equal(db.renameDebate(id, "Nome scelto"), true);
  assert.equal(db.renameDebate(999_999, "x"), false);
  assert.equal(db.finishDebate(id, "done", "verdetto", "Titolo del giudice", "alta"), "Nome scelto");
  const d = db.getDebate(id)!;
  assert.equal(d.title, "Nome scelto");
  assert.equal(d.updated_at, before);
  // Senza rinomina vince il titolo del giudice.
  const id2 = db.createDebate("domanda", ["a"], opts);
  assert.equal(db.finishDebate(id2, "done", "verdetto", "Titolo del giudice", "alta"), "Titolo del giudice");
});
