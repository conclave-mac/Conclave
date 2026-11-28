// Contrasto WCAG dei colori di `macos/Brand.swift` usati come testo (P1.3).
// I valori si leggono dal file Swift, così il test segue ogni modifica dei token.
// Soglie (HIG Accessibility): testo fino a 17 pt ≥ 4,5:1; con "Aumenta contrasto" ≥ 7:1.
// Uso: node --test tests/unit/contrast.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../macos/Brand.swift", import.meta.url), "utf8");

const lum = (rgb) => {
  const c = rgb.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hex = (h) => [h >> 16 & 255, h >> 8 & 255, h & 255];
// Colore con alfa sopra un fondo opaco.
const over = (rgb, alpha, bg) => rgb.map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)));

/** Blocco `NSColor(name: "<name>") { … })` del file. */
function block(name) {
  const i = src.indexOf(`NSColor(name: "${name}")`);
  assert.ok(i >= 0, `${name} non trovato in Brand.swift`);
  return src.slice(i, src.indexOf("})", i));
}

/** Fondo opaco: [scuro, chiaro] dalle due `srgbRed:` del blocco (scuro prima, come in tutto il file). */
function background(name) {
  const m = [...block(name).matchAll(/srgbRed: 0x(\w\w) \/ 255, green: 0x(\w\w) \/ 255, blue: 0x(\w\w) \/ 255/g)];
  assert.equal(m.length, 2, `${name}: attese due varianti`);
  const [dark, light] = m.map((x) => x.slice(1, 4).map((v) => parseInt(v, 16)));
  return { dark, light };
}

/** Colore di stato: `status("<name>", light: 0x…, lightMore: 0x…, dark: 0x…, darkMore: 0x…)`. */
function status(name) {
  const m = src.match(new RegExp(`status\\("${name}", light: 0x(\\w{6}), lightMore: 0x(\\w{6}), dark: 0x(\\w{6}), darkMore: 0x(\\w{6})\\)`));
  assert.ok(m, `${name}: formato status(...) non trovato`);
  const [light, lightMore, dark, darkMore] = m.slice(1).map((v) => hex(parseInt(v, 16)));
  return { light, lightMore, dark, darkMore };
}

/** Grigio con alfa: `NSColor(white: W, alpha: more ? A : B)`; [scuro, chiaro] con e senza contrasto. */
function gray(name) {
  const m = [...block(name).matchAll(/NSColor\(white: ([\d.]+), alpha: more \? ([\d.]+) : ([\d.]+)\)/g)];
  assert.equal(m.length, 2, `${name}: attese due varianti`);
  const v = m.map((x) => ({ rgb: Array(3).fill(Math.round(parseFloat(x[1]) * 255)), more: +x[2], normal: +x[3] }));
  return { dark: v[0], light: v[1] };
}

// Fondi su cui compaiono i testi: contenuto, riquadri, barre laterali/Impostazioni, verdetto.
const BACKGROUNDS = ["BrandCanvas", "BrandSurface", "BrandSidebarTintOpaque", "BrandVerdictSurface"].map((n) => [n, background(n)]);

// BrandAccentText: l'accento come testo (link del Markdown, pulsanti a link), stesse soglie degli stati.
for (const name of ["BrandWarning", "BrandDanger", "BrandAccentText"]) {
  test(`${name}: ≥ 4,5:1 e ≥ 7:1 con Aumenta contrasto`, () => {
    const c = status(name);
    for (const [bg, { dark, light }] of BACKGROUNDS) {
      for (const [label, fg, base, min] of [
        ["chiaro", c.light, light, 4.5], ["chiaro+contrasto", c.lightMore, light, 7],
        ["scuro", c.dark, dark, 4.5], ["scuro+contrasto", c.darkMore, dark, 7],
      ]) {
        const r = ratio(fg, base);
        assert.ok(r >= min, `${name} ${label} su ${bg}: ${r.toFixed(2)}:1 < ${min}:1`);
      }
    }
  });
}

test("BrandSecondaryText: ≥ 4,5:1 e ≥ 7:1 con Aumenta contrasto", () => {
  const g = gray("BrandSecondaryText");
  for (const [bg, { dark, light }] of BACKGROUNDS) {
    for (const [label, v, base] of [["chiaro", g.light, light], ["scuro", g.dark, dark]]) {
      const n = ratio(over(v.rgb, v.normal, base), base), m = ratio(over(v.rgb, v.more, base), base);
      assert.ok(n >= 4.5, `secondario ${label} su ${bg}: ${n.toFixed(2)}:1`);
      assert.ok(m >= 7, `secondario ${label}+contrasto su ${bg}: ${m.toFixed(2)}:1`);
    }
  }
});

test("BrandText (chip selezionate): ≥ 7:1", () => {
  const b = block("BrandText");
  const [dark, light] = [...b.matchAll(/NSColor\(white: ([\d.]+), alpha: ([\d.]+)\)/g)].map((x) => ({ rgb: Array(3).fill(Math.round(+x[1] * 255)), a: +x[2] }));
  for (const [bg, bgs] of BACKGROUNDS) {
    for (const [label, v, base] of [["chiaro", light, bgs.light], ["scuro", dark, bgs.dark]]) {
      const r = ratio(over(v.rgb, v.a, base), base);
      assert.ok(r >= 7, `testo ${label} su ${bg}: ${r.toFixed(2)}:1`);
    }
  }
});

test("BrandText sulla chip selezionata (accento al 10% sopra il fondo): ≥ 7:1", () => {
  const accent = background("BrandAccent");
  const b = block("BrandText");
  const [dark, light] = [...b.matchAll(/NSColor\(white: ([\d.]+), alpha: ([\d.]+)\)/g)].map((x) => ({ rgb: Array(3).fill(Math.round(+x[1] * 255)), a: +x[2] }));
  for (const [bg, bgs] of BACKGROUNDS) {
    for (const [label, v, acc, base] of [["chiaro", light, accent.light, bgs.light], ["scuro", dark, accent.dark, bgs.dark]]) {
      const fill = over(acc, 0.1, base);
      const r = ratio(over(v.rgb, v.a, fill), fill);
      assert.ok(r >= 7, `chip selezionata ${label} su ${bg}: ${r.toFixed(2)}:1`);
    }
  }
});
