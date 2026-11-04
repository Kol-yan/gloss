import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckBar } from "@/features/editor/check-bar";
import type { SentenceFlag } from "@/features/editor/sentence-detect";
import { SentenceFlagCard, excerpt } from "@/features/editor/sentence-flag-card";
import { SuggestionRail } from "@/features/editor/suggestion-rail";
import type { Suggestion } from "@/shared/contracts";

const noop = () => {};

function flag(overrides: Partial<SentenceFlag> = {}): SentenceFlag {
  return {
    id: "a".repeat(64),
    start: 0,
    end: 25,
    text: "I go to school every day.",
    categories: ["correction", "clarity", "word_choice"],
    scores: { correction: 0.9, clarity: 0.6, word_choice: 0.7 },
    ...overrides,
  };
}

function card(props: Partial<Parameters<typeof SentenceFlagCard>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SentenceFlagCard, {
      flag: flag(),
      active: false,
      onActivate: noop,
      onDeactivate: noop,
      onFocusCard: noop,
      onDismiss: noop,
      ...props,
    }),
  );
}

describe("sentence flag card", () => {
  it("shows categories as status labels, with no click-to-analyze buttons", () => {
    const html = card();
    for (const label of ["Correction", "Clarity", "Word choice"]) {
      expect(html).toContain(`${label}</span>`);
      expect(html).not.toContain(`aria-label="${label}: review this sentence"`);
    }
    expect(html).toContain("I go to school every day.");
    expect(html).not.toContain(">Apply<");
    expect(html).not.toContain("Analyzing");
    expect(html).toContain("Preparing analysis");
  });

  it("shows only the badges the detector raised", () => {
    const html = card({ flag: flag({ categories: ["clarity"] }) });
    expect(html).toContain("Clarity</span>");
    expect(html).not.toContain("Correction");
    expect(html).not.toContain("Word choice");
  });

  it("says Analyzing while the generator runs, and disables the badges", () => {
    const html = card({ job: "analyzing" });
    expect(html).toContain("Analyzing…");
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/disabled=""/g)?.length).toBe(1);
    expect(html).not.toContain("%");
  });

  it("explains a failure in plain words without provider details", () => {
    expect(card({ job: "failed" })).toContain("We couldn&#x27;t review this sentence just now.");
    expect(card({ job: "quota" })).toContain("They come back tomorrow.");
    expect(card({ job: "unavailable" })).toContain("AI checking isn&#x27;t available today.");
  });

  it("shortens a long sentence for the card", () => {
    const long = `${"word ".repeat(60)}end.`;
    expect(excerpt(long).length).toBeLessThanOrEqual(111);
    expect(excerpt(long).endsWith("…")).toBe(true);
    expect(excerpt("Line one\n\n  line two.")).toBe("Line one line two.");
  });
});

describe("suggestion rail with flagged sentences", () => {
  const text = "I go to school every day. She like apples very much. We eat lunch at noon.";
  const suggestion: Suggestion = {
    id: "ai-1",
    source: "ai",
    category: "error",
    start: 30,
    end: 34,
    original: "like",
    replacement: "likes",
    reason: "Use the third person form.",
    meaningChange: false,
    meaning: null,
  };

  function rail(props: Partial<Parameters<typeof SuggestionRail>[0]> = {}) {
    return renderToStaticMarkup(
      createElement(SuggestionRail, {
        suggestions: [suggestion],
        flags: [flag(), flag({ id: "b".repeat(64), start: 53, end: 74, text: "We eat lunch at noon." })],
        text,
        activeId: null,
        canUndo: false,
        notice: null,
        textIsEmpty: false,
        checkedClean: false,
        onActivate: noop,
        onDeactivate: noop,
        onFocusCard: noop,
        onApply: noop,
        onDismiss: noop,
        onUndo: noop,
        ...props,
      }),
    );
  }

  it("shows detection only in the AI indicator before the tab opens", () => {
    const html = rail();
    expect(html).toContain('data-tab-indicator="ai"');
    expect(html).toContain('aria-label="3 sentences or suggestions"');
    expect(html).not.toContain("data-flag-card");
    expect(html).not.toContain("data-suggestion-id");
    expect(rail({ activeTab: "ai" })).toContain("data-suggestion-id");
    expect(rail({ activeTab: "ai" })).toContain("data-flag-card");
  });

  it("explains the automatic flow in the empty state", () => {
    const html = rail({ activeTab: "ai", suggestions: [], flags: [], autoDetect: true });
    expect(html).toContain("when you pause typing");
    expect(rail({ activeTab: "ai", suggestions: [], flags: [], autoDetect: false })).toContain("Press Check with AI for a closer look.");
  });
});

describe("check bar scanning status", () => {
  const base = { status: "idle", checksLeft: 5, textIsEmpty: false, length: 40, suggestionCount: 0, onCheck: noop, onOpenSheet: noop } as const;

  it("says so only while a detector request is really running", () => {
    expect(renderToStaticMarkup(createElement(CheckBar, { ...base, detectStatus: "scanning" }))).toContain("Looking for sentences to improve…");
    expect(renderToStaticMarkup(createElement(CheckBar, { ...base, detectStatus: "idle" }))).not.toContain("Looking for");
  });

  it("tells the learner when automatic suggestions are used up and the button still works", () => {
    const html = renderToStaticMarkup(createElement(CheckBar, { ...base, detectStatus: "quota" }));
    expect(html).toContain("Automatic suggestions are used up for today. Check with AI still works.");
    expect(html).not.toContain('disabled=""');
  });
});
