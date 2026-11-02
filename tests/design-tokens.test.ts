import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Contrast guard for the design tokens: text roles must meet WCAG AA on every
// surface they can appear on, in both themes.
const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

function tokens(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) result[match[1]] = match[2];
  return result;
}

const lightBlock = css.slice(css.indexOf("@theme"), css.indexOf("@media (prefers-color-scheme: dark)"));
const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
const darkBlock = css.slice(darkStart, css.indexOf("@layer base"));

const themes = {
  light: tokens(lightBlock),
  dark: { ...tokens(lightBlock), ...tokens(darkBlock) },
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["paper", "paper-deep", "surface", "card"];
const STATES = ["success", "caution", "error", "info", "neutral"];

describe.each(Object.entries(themes))("%s theme", (_name, t) => {
  it("defines every token the checks use", () => {
    for (const name of [...SURFACES, "ink", "ink-muted", "line-strong", "accent", "accent-strong", "accent-soft", "on-accent"]) {
      expect(t[name], name).toBeDefined();
    }
    for (const s of STATES) expect(t[s] && t[`${s}-soft`], s).toBeDefined();
  });

  it("body and secondary text meet 4.5:1 on every surface", () => {
    for (const surface of SURFACES) {
      for (const text of ["ink", "ink-muted"]) {
        expect(contrast(t[text], t[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(t["ink-muted"], t["accent-soft"])).toBeGreaterThanOrEqual(4.5);
  });

  it("state text meets 4.5:1 on its soft fill and on the surfaces", () => {
    for (const s of STATES) {
      for (const bg of [`${s}-soft`, "card", "paper", "paper-deep"]) {
        expect(contrast(t[s], t[bg]), `${s} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("buttons and links are readable", () => {
    expect(contrast(t["on-accent"], t["accent"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["on-accent"], t["accent-strong"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["accent-strong"], t["accent-soft"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["accent"], t["paper"])).toBeGreaterThanOrEqual(4.5);
  });

  it("field edges and highlight lines meet 3:1 against the card", () => {
    expect(contrast(t["line-strong"], t["card"])).toBeGreaterThanOrEqual(3);
    for (const mark of ["caution-mark", "error-mark", "info-mark"]) {
      expect(contrast(t[mark], t["card"]), mark).toBeGreaterThanOrEqual(3);
    }
  });
});
