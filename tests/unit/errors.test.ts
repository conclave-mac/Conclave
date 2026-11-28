// Codice claude_credits: Claude Code che chiede crediti o un piano separato per l'uso programmatico (claude -p).
// Il testo vero non è noto (annuncio di maggio 2026, sospeso il 15 giugno): frasi plausibili, e nessun falso positivo
// su rete, login e limite di utilizzo di Pro.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isClaudeCreditsMessage, errorCode, CodedError } from "../../src/errors.ts";

const CREDITS = [
  "Claude Code programmatic usage (claude -p) now requires Agent SDK credits. Purchase credits at claude.ai/settings/billing.",
  "Your Pro plan does not include programmatic usage. Upgrade your plan or buy Agent SDK credits to continue.",
  "Agent SDK usage is billed separately: add credits to your account or switch to a plan that includes it.",
  "Non-interactive mode requires a separate subscription. Visit claude.ai/upgrade to purchase usage.",
  "You've used all your Agent SDK credits for this month. Purchase more credits to keep using claude -p.",
  "Headless usage is not included in your plan.",
  "Insufficient credits: purchase additional credits to use Claude Code from other applications.",
];

const NOT_CREDITS = [
  "Claude AI usage limit reached|1764340800",
  "You've hit your usage limit · resets 5pm (Europe/Rome). /upgrade to increase your usage limit.",
  "You've reached your limit for your plan. Your limit resets at 6pm.",
  "Credit balance is too low",
  "Invalid API key · Please run /login",
  "OAuth token has expired. Please obtain a new token or refresh your existing token.",
  "Please run /login to sign in to your Claude account.",
  "API Error: Connection error. (fetch failed) — check your plan's network settings",
  "API Error: Request timed out. Purchase not completed.",
  "getaddrinfo ENOTFOUND api.anthropic.com",
  "API Error: 529 Overloaded",
  "API Error: 500 Internal server error",
  "Prompt is too long",
];

test("isClaudeCreditsMessage: frasi su crediti o piano separato per l'uso programmatico", () => {
  for (const m of CREDITS) assert.ok(isClaudeCreditsMessage(m), m);
});

test("isClaudeCreditsMessage: niente falsi positivi su rete, login, limite di Pro e altri errori", () => {
  for (const m of NOT_CREDITS) assert.ok(!isClaudeCreditsMessage(m), m);
});

test("errorCode: claude_credits solo per i messaggi della Claude CLI; il limite di Pro resta quota_exhausted", () => {
  for (const m of CREDITS) assert.equal(errorCode(new Error(`Claude: ${m}`)), "claude_credits", m);
  assert.equal(errorCode(new Error(`Claude (exit 1): ${CREDITS[0]}`)), "claude_credits");
  assert.equal(errorCode(new CodedError("claude_credits", "x")), "claude_credits");
  assert.equal(errorCode(new Error("Claude: Claude AI usage limit reached|1764340800")), "quota_exhausted");
  assert.equal(errorCode(new Error("Claude: Credit balance is too low")), "quota_exhausted");
  assert.equal(errorCode(new Error("Claude: Invalid API key · Please run /login")), "invalid_key");
  // Un provider diverso da Claude con una frase simile resta com'era.
  assert.notEqual(errorCode(new Error("HTTP 402: Insufficient credits: purchase additional credits")), "claude_credits");
});
