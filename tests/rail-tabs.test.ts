import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { nextRailTab, railIndicators, tabForSuggestion } from "@/features/editor/rail-state";
import { SuggestionRail } from "@/features/editor/suggestion-rail";
import { createDoc, editorReducer } from "@/features/editor/editor-reducer";
import { matchExpressions, unassistedMatches } from "@/lib/expression-matches";
import type { Expression, Suggestion } from "@/shared/contracts";

const expression: Expression = { id: "e", text: "bottleneck", meaning: "Something that slows progress.", familiarity: "new" };
const local: Suggestion = { id: "local", source: "local", category: "error", start: 0, end: 4, original: "slow", replacement: "slower", reason: "Grammar.", meaningChange: false, meaning: null };
const ai: Suggestion = { ...local, id: "ai", source: "ai" };
const learning: Suggestion = { ...ai, id: "learning", category: "expression", origin: "learning", replacement: "bottleneck", meaning: expression.meaning };
const noop = () => {};
function rail(props: Partial<Parameters<typeof SuggestionRail>[0]> = {}) {
  return renderToStaticMarkup(createElement(SuggestionRail, {
    suggestions: [local, ai, learning], text: "slow", activeId: null,
    canUndo: true, notice: null, textIsEmpty: false, checkedClean: false,
    onActivate: noop, onDeactivate: noop, onFocusCard: noop, onApply: noop, onDismiss: noop, onUndo: noop,
    ...props,
  }));
}

describe("rail tabs", () => {
  it("starts on instant Checks and keeps the other channels out of its panel", () => {
    const html = rail();
    expect(html).toContain('data-suggestion-id="local"');
    expect(html).not.toContain('data-suggestion-id="ai"');
    expect(html).not.toContain('data-suggestion-id="learning"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain(">Undo<");
  });
  it("routes each suggestion to its channel and counts learning comments separately", () => {
    expect([local, ai, learning].map(tabForSuggestion)).toEqual(["checks", "ai", "learning"]);
    expect(railIndicators([local, ai, learning], 2, 1)).toEqual({ checks: 1, ai: 3, learning: 2 });
    expect(railIndicators([], 0, 0)).toEqual({ checks: 0, ai: 0, learning: 0 });
    const html = rail({ activeTab: "learning", learningExpressions: [expression] });
    expect(html).toContain("You used one of your words:");
    expect(html).toContain('data-suggestion-id="learning"');
    expect(html).not.toContain('data-suggestion-id="ai"');
    expect(html.match(/href="\/practice"/g)).toHaveLength(1);
    expect(html).not.toContain("Start practice");
  });
  it("supports arrow, Home and End keyboard navigation without resetting on new data", () => {
    expect(nextRailTab("checks", "ArrowLeft")).toBe("learning");
    expect(nextRailTab("learning", "ArrowRight")).toBe("checks");
    expect(nextRailTab("ai", "Home")).toBe("checks");
    expect(nextRailTab("ai", "End")).toBe("learning");
    expect(nextRailTab("learning", "Tab")).toBe("learning");
    expect(rail({ activeTab: "ai", suggestions: [local, ai] })).toContain('data-suggestion-id="ai"');
  });
  it("lights the Learning indicator for local use and for actual pending activity", () => {
    expect(rail({ suggestions: [], learningExpressions: [expression] })).toContain('data-tab-indicator="learning"');
    expect(rail({ suggestions: [], learningStatus: "pending" })).toContain('data-tab-indicator="learning"');
    expect(rail({ suggestions: [] })).not.toContain("data-tab-indicator");
    expect(rail({ activeTab: "learning", learningStatus: "pending" })).toContain("Looking for a natural fit");
    expect(rail({ activeTab: "learning", suggestions: [], learningStatus: "ready" })).toContain("Nothing from your list fits");
  });
});

describe("deterministic real-writing matches", () => {
  it("recognizes regular inflection, irregular phrases, case and UTF-16 spans", () => {
    const phrase = { ...expression, id: "p", text: "take off the table" };
    const text = "\u{1f642} Bottlenecks remain. We took off the table.";
    const matches = matchExpressions(text, [expression, phrase]);
    expect(matches.map((match) => text.slice(match.start, match.end))).toEqual(["Bottlenecks", "took off the table"]);
    expect(matchExpressions("It was pushed back.", [{ ...phrase, text: "push back" }])).toHaveLength(1);
    expect(matchExpressions("The trade-offs matter.", [{ ...phrase, text: "trade-off" }])).toHaveLength(1);
  });
  it("does not match substrings, skipped words or across sentences", () => {
    expect(matchExpressions("bottleneckingness", [expression])).toHaveLength(0);
    expect(matchExpressions("take this off the table", [{ ...expression, text: "take off the table" }])).toHaveLength(0);
    expect(matchExpressions("take. Off the table", [{ ...expression, text: "take off the table" }])).toHaveLength(0);
  });
  it("never turns accepted help into independent use through Apply, typing or Undo", () => {
    let doc = createDoc("slow", [learning]);
    doc = editorReducer(doc, { type: "apply", id: learning.id });
    expect(matchExpressions(doc.text, [expression])).toHaveLength(1);
    expect(unassistedMatches(doc.text, [expression], doc.assisted)).toHaveLength(0);
    doc = editorReducer(doc, { type: "edit", text: "Many bottlenecks remain." });
    expect(unassistedMatches(doc.text, [expression], doc.assisted)).toHaveLength(0);
    const undone = editorReducer(editorReducer(createDoc("slow", [learning]), { type: "apply", id: learning.id }), { type: "undo" });
    expect(undone.text).toBe("slow");
    expect(unassistedMatches(undone.text, [expression], undone.assisted)).toHaveLength(0);
  });
  it("keeps independent occurrences elsewhere separate from the assisted one", () => {
    const text = "bottlenecks slow";
    let doc = createDoc(text, [{ ...learning, start: 12, end: 16 }]);
    doc = editorReducer(doc, { type: "apply", id: learning.id });
    expect(unassistedMatches(doc.text, [expression], doc.assisted).map((match) => match.start)).toEqual([0]);
    doc = editorReducer(doc, { type: "edit", text: "Existing " + doc.text });
    expect(unassistedMatches(doc.text, [expression], doc.assisted).map((match) => match.start)).toEqual([9]);
  });
  it("keeps Learning and unbiased AI results when the other channel updates", () => {
    let doc = createDoc("slow", [learning]);
    doc = editorReducer(doc, { type: "receive", source: "ai", forText: "slow", suggestions: [ai] });
    expect(doc.suggestions.map((s) => s.id)).toContain("learning");
    doc = editorReducer(doc, { type: "receiveLearning", forText: "slow", suggestions: [learning] });
    expect(doc.suggestions.map((s) => s.id)).toContain("ai");
  });
});
