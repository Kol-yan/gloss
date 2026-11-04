import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Onboarding, ONBOARDING_STEPS, type OnboardingStep } from "@/features/onboarding/onboarding";
import { BrandLockup, BrandName } from "@/components/brand";
import type { WordCheckResponse } from "@/shared/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
const round: WordCheckResponse = {
  entries: [
    { id: "one", text: "reluctant", level: "B2", definition: "not willing to do something", example: "She was reluctant to ask for help.", answer: "know_unused" },
    { id: "two", text: "thorough", level: "B2", definition: "complete and careful", answer: null },
  ], roundSize: 2, answered: 1, completed: false, level: "B2",
};
const render = (step: OnboardingStep, data = round) => renderToStaticMarkup(createElement(Onboarding, { initialStep: step, initialRound: data }));

describe("onboarding screens", () => {
  it("renders all six steps in one window without a Skip action", () => {
    for (const step of ONBOARDING_STEPS) {
      const html = render(step);
      expect(html).toContain('aria-label="Get started with gloss"');
      expect(html).toContain(`data-step="${step}"`);
      expect(html).not.toMatch(/>Skip/);
    }
  });
  it("offers the four F1 level groups in descending order and a quiet unsure action", () => {
    const html = render("level");
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html.indexOf("Proficient or native")).toBeLessThan(html.indexOf("Advanced"));
    expect(html.indexOf("Advanced")).toBeLessThan(html.indexOf("Intermediate"));
    expect(html.indexOf("Intermediate")).toBeLessThan(html.indexOf("Elementary"));
    expect(html).toContain("Not sure? The word check will tell.");
  });
  it("uses real words and examples, accessible answers, and no invented IPA", () => {
    const html = render("check", { ...round, entries: [{ ...round.entries[0], answer: null }], roundSize: 1, answered: 0 });
    expect(html).toContain("reluctant");
    expect(html).toContain("She was reluctant to ask for help.");
    expect(html).toContain("IPA unavailable");
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html).toContain('role="progressbar"');
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Next<\/button>/);
  });
  it("puts only known but unused words on the line", () => {
    const html = render("map");
    expect(html).toContain('class="wl-chip">reluctant');
    expect(html).not.toContain('class="wl-chip">thorough');
    expect(html).toContain("Why these first?");
    const empty = render("map", { ...round, entries: [{ ...round.entries[0], answer: "use" }] });
    expect(empty).not.toContain("words you know but don");
    expect(empty).toContain("find more words to practice");
  });
  it("links both tools to existing README installation sections and colors the running brand", () => {
    const html = render("tools");
    expect(html).toContain("https://github.com/Kol-yan/gloss#browser-extension");
    expect(html).toContain("https://github.com/Kol-yan/gloss#desktop-app");
    expect(html).toContain('class="brand-word">gloss');
  });
  it("provides the eight-segment closing bar and one start action", () => {
    const html = render("ready");
    expect(html).toContain('aria-label="First practice: 8 words"');
    expect(html.match(/<i><\/i>/g)).toHaveLength(8);
    expect(html).toContain("Start first practice");
    expect(html).toContain("Install tools");
  });
  it("does not promise eight words when the check has no words on the line", () => {
    const html = render("ready", { ...round, entries: [{ ...round.entries[0], answer: "use" }] });
    expect(html).toContain("Open practice");
    expect(html).toContain("Add words while you write");
    expect(html).not.toContain("8 words, about 6 minutes");
  });
  it("uses a tile whenever the mark and name appear together", () => {
    const html = renderToStaticMarkup(createElement(BrandLockup));
    expect(html).toContain('class="brand-tile"');
    expect(html).toContain('class="brand-name"');
    expect(renderToStaticMarkup(createElement(BrandName))).toContain('class="brand-word"');
  });
});
