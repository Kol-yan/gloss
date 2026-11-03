import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { describeChange, splitSpaces, spoken } from "@/features/editor/change-view";
import { SuggestionCard } from "@/features/editor/suggestion-card";
import type { Suggestion } from "@/shared/contracts";

function suggest(text: string, original: string, replacement: string, overrides: Partial<Suggestion> = {}): Suggestion {
  const start = text.indexOf(original);
  if (start === -1) throw new Error(`fragment not found: ${original}`);
  return {
    id: "s",
    source: "local",
    category: "error",
    start,
    end: start + original.length,
    original,
    replacement,
    reason: "Harper says so.",
    meaningChange: false,
    meaning: null,
    ...overrides,
  };
}

describe("describeChange", () => {
  it("labels a missing space after a comma and shows the words around it", () => {
    const text = "Thanks for the help yesterday,and good luck with the rest.";
    const view = describeChange(text, suggest(text, ",", ", "));
    expect(view).toEqual({
      before: "…the help yesterday,",
      removed: "",
      added: " ",
      after: "and good luck…",
      label: "Add a space after the comma",
    });
  });

  it("reads a glued span ('Enor,ous') as one missing space, with the comma kept as context", () => {
    const text = "This is Enor,ous and good.";
    const view = describeChange(text, suggest(text, "Enor,ous", "Enor, ous"));
    expect(view).toMatchObject({
      before: "This is Enor,",
      removed: "",
      added: " ",
      after: "ous and good.",
      label: "Add a space after the comma",
    });
  });

  it("names removed double spaces and spaces before punctuation", () => {
    const double = "He is here  and well.";
    expect(describeChange(double, suggest(double, "  ", " "))).toMatchObject({ removed: " ", added: "", label: "Remove the extra space" });

    const before = "Well , it works.";
    expect(describeChange(before, suggest(before, " ,", ","))).toMatchObject({ label: "Remove the space before the comma" });
  });

  it("leaves a joined or split word to the words themselves", () => {
    const joined = "I can not attend.";
    expect(describeChange(joined, suggest(joined, "can not", "cannot"))).toMatchObject({
      before: "I can",
      removed: " ",
      added: "",
      after: "not attend.",
      label: null,
    });
    const split = "I read alot of books.";
    expect(describeChange(split, suggest(split, "alot", "a lot"))).toMatchObject({ removed: "", added: " ", label: null });
  });

  it("names added, removed and swapped punctuation", () => {
    const missing = "Yes I will come";
    expect(describeChange(missing, suggest(missing, "Yes", "Yes,")).label).toBe("Add a comma");
    const extra = "Yes, I will come.";
    expect(describeChange(extra, suggest(extra, "Yes,", "Yes")).label).toBe("Remove the comma");
    const swap = "Is it done.";
    expect(describeChange(swap, suggest(swap, "done.", "done?")).label).toBe("Change the period to a question mark");
  });

  it("gives no label to word edits and widens them to the whole word", () => {
    const text = "An apple and a orange are here.";
    const article = describeChange(text, suggest(text, "a orange", "an orange"));
    expect(article).toMatchObject({ removed: "a", added: "an", label: null, before: "An apple and ", after: " orange are here." });

    const spelling = "I recieve the mail.";
    expect(describeChange(spelling, suggest(spelling, "recieve", "receive"))).toMatchObject({
      removed: "recieve",
      added: "receive",
      before: "I ",
      after: " the mail.",
      label: null,
    });
  });

  it("shows a removal without eating the neighbouring word", () => {
    const text = "This is is fine.";
    const view = describeChange(text, suggest(text, "is ", "", { start: 5, end: 8 }));
    expect(view).toMatchObject({ removed: "is ", added: "", before: "This ", after: "is fine.", label: null });
  });

  it("cuts long context to a few words with an ellipsis and stays inside the paragraph", () => {
    const text = "First paragraph ends here.\nOne two three four five six recieve seven eight nine ten eleven twelve.";
    const view = describeChange(text, suggest(text, "recieve", "receive"));
    expect(view.before).toBe("…four five six ");
    expect(view.after).toBe(" seven eight nine…");
    const atLineStart = describeChange(text, suggest(text, "One", "Won"));
    expect(atLineStart.before).toBe("");
  });

  it("shows nothing around a suggestion that no longer fits the text", () => {
    const view = describeChange("Different text now.", { ...suggest("old recieve", "recieve", "receive") });
    expect(view).toEqual({ before: "", after: "", removed: "recieve", added: "receive", label: null });
  });
});

describe("visible spaces", () => {
  it("marks spaces at the edges, doubled or alone, but not single spaces between words", () => {
    expect(splitSpaces(", ")).toEqual([
      { text: ",", marker: false },
      { text: "␣", marker: true },
    ]);
    expect(splitSpaces(" ")).toEqual([{ text: "␣", marker: true }]);
    expect(splitSpaces("a  b")).toEqual([
      { text: "a", marker: false },
      { text: "␣␣", marker: true },
      { text: "b", marker: false },
    ]);
    expect(splitSpaces("an orange")).toEqual([{ text: "an orange", marker: false }]);
    expect(splitSpaces("a\nb")).toEqual([
      { text: "a", marker: false },
      { text: "↵", marker: true },
      { text: "b", marker: false },
    ]);
  });

  it("reads fragments aloud with the spaces spelled out", () => {
    expect(spoken("")).toBe("nothing");
    expect(spoken(" ")).toBe("space");
    expect(spoken(", ")).toBe(", space");
    expect(spoken("recieve")).toBe("recieve");
  });
});

function render(text: string, suggestion: Suggestion): string {
  return renderToStaticMarkup(
    createElement(SuggestionCard, {
      suggestion,
      text,
      active: false,
      onActivate: () => {},
      onDeactivate: () => {},
      onFocusCard: () => {},
      onApply: () => {},
      onDismiss: () => {},
    }),
  );
}

describe("SuggestionCard", () => {
  const text = "Thanks for the help yesterday,and good luck.";

  it("explains a local spacing fix with a label, a visible space marker and the words around it", () => {
    const html = render(text, suggest(text, ",", ", ", { category: "style", reason: "Use a space after a comma." }));
    expect(html).toContain("Add a space after the comma");
    expect(html).toContain("␣");
    expect(html).toContain("…the help yesterday,");
    expect(html).toContain("and good luck.");
    expect(html).toContain('aria-label="Apply: Add a space after the comma"');
    // The label already says what Harper's message says.
    expect(html).not.toContain("Use a space after a comma.");
  });

  it("keeps the reason on a cloud suggestion even when it has a label", () => {
    const html = render(text, suggest(text, ",", ", ", { source: "ai", reason: "A comma needs a space after it." }));
    expect(html).toContain("Add a space after the comma");
    expect(html).toContain("A comma needs a space after it.");
  });

  it("keeps original and replacement for a word edit and shows the context", () => {
    const spelling = "I recieve the mail.";
    const html = render(spelling, suggest(spelling, "recieve", "receive"));
    expect(html).toContain("line-through");
    expect(html).toContain("recieve");
    expect(html).toContain("receive");
    expect(html).toContain("the mail.");
    expect(html).toContain("Harper says so.");
    expect(html).toContain('aria-label="Apply: recieve to receive"');
  });

  it("draws the spaces of a spacing-only replacement when the label does not apply", () => {
    const wide = "Yes,  please";
    const html = render(wide, suggest(wide, "  ", " "));
    expect(html).toContain("Remove the extra space");
    expect(html).toContain("␣");
  });
});
