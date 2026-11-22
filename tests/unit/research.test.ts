// Chi fa la ricerca sul web (findResearcher): Claude solo se scelto come voce o giudice, altrimenti GPT-OSS
// su Groq (anche se non scelto), altrimenti nessuno. Config e cartella dati temporanee, mai quelle reali.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "council-unit-"));
const cfgPath = join(dir, "models.json");
writeFileSync(cfgPath, JSON.stringify({
  providers: {
    groq: { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyEnv: "UNIT_GROQ_KEY" },
    google: { name: "Google", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "UNIT_GEMINI_KEY" },
  },
  judge: { id: "claude", label: "Claude", kind: "claude-cli", model: "sonnet" },
  models: [
    { id: "claude", label: "Claude", kind: "claude-cli", model: "sonnet" },
    { id: "gemini", label: "Gemini", kind: "openai", provider: "google", model: "gemini-3-flash", family: "gemini" },
    { id: "gptoss", label: "GPT-OSS", kind: "openai", provider: "groq", model: "openai/gpt-oss-120b", family: "gpt-oss" },
  ],
}));
process.env.COUNCIL_DATA = dir;
process.env.COUNCIL_MODELS = cfgPath;
process.env.UNIT_GEMINI_KEY = "chiave-finta-gemini";
process.env.UNIT_GROQ_KEY = "chiave-finta-groq";
const { findResearcher } = await import("../../src/debate/research.ts");
const { config } = await import("../../src/config.ts");
after(() => rmSync(dir, { recursive: true, force: true }));

const def = (id: string) => config.models.find((m) => m.id === id)!;
const who = (r: { def: { id: string }; via: string } | null) => (r ? `${r.def.id}/${r.via}` : null);

test("findResearcher: solo Gemini scelto (giudice Gemini) → GPT-OSS su Groq, anche se non è una voce", () => {
  assert.equal(who(findResearcher({ models: [def("gemini")], judge: def("gemini") })), "gptoss/GPT-OSS (Groq)");
});

test("findResearcher: Claude tra le voci → Claude", () => {
  assert.equal(who(findResearcher({ models: [def("gemini"), def("claude")], judge: def("gemini") })), "claude/Claude");
});

test("findResearcher: Claude solo giudice → Claude", () => {
  assert.equal(who(findResearcher({ models: [def("gemini"), def("gptoss")], judge: { ...def("claude"), model: "haiku" } })), "claude/Claude");
});

test("findResearcher: GPT-OSS scelto e Claude no → GPT-OSS", () => {
  assert.equal(who(findResearcher({ models: [def("gptoss")], judge: def("gptoss") })), "gptoss/GPT-OSS (Groq)");
});

test("findResearcher: senza selezione (GET /api/models) → chi può cercare in generale, Claude prima", () => {
  assert.equal(who(findResearcher()), "claude/Claude");
  assert.equal(who(findResearcher({ models: [] })), "gptoss/GPT-OSS (Groq)");
});

test("findResearcher: né Claude scelto né chiave Groq → nessuno", () => {
  const key = process.env.UNIT_GROQ_KEY;
  delete process.env.UNIT_GROQ_KEY;
  try {
    assert.equal(findResearcher({ models: [def("gemini")], judge: def("gemini") }), null);
    // Con Claude scelto la ricerca resta possibile anche senza Groq.
    assert.equal(who(findResearcher({ models: [def("gemini")], judge: def("claude") })), "claude/Claude");
  } finally {
    process.env.UNIT_GROQ_KEY = key;
  }
});
