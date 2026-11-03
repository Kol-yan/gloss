import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDoc, editorReducer } from "@/features/editor/editor-reducer";
import { InlinePopover } from "@/features/editor/inline-popover";
import {
  pickSuggestion,
  placePopover,
  popoverReducer,
  sortedIndex,
  stepSuggestion,
  suggestionForCaret,
  syncPopover,
  type PopoverState,
} from "@/features/editor/popover-state";
import { SuggestionRail } from "@/features/editor/suggestion-rail";
import type { Suggestion } from "@/shared/contracts";

const TEXT = "I recieve the mail. It was unfortunatelly late. We goed home.";

function suggest(fragment: string, replacement: string, overrides: Partial<Suggestion> = {}): Suggestion {
  const start = TEXT.indexOf(fragment);
  return {
    id: `s-${fragment}`,
    source: "local",
    category: "error",
    start,
    end: start + fragment.length,
    original: fragment,
    replacement,
    reason: "Spelling.",
    meaningChange: false,
    meaning: null,
    ...overrides,
  };
}

const a = suggest("recieve", "receive");
const b = suggest("unfortunatelly", "unfortunately");
const c = suggest("goed", "went");
const all = [c, a, b];

describe("pickSuggestion", () => {
  it("prefers the more urgent category, then the narrower range", () => {
    const style = suggest("recieve the mail", "get the mail", { id: "style", category: "style" });
    const expression = suggest("recieve the", "x", { id: "expr", category: "expression" });
    expect(pickSuggestion([style, expression, a])?.id).toBe(a.id);
    expect(pickSuggestion([style, expression])?.id).toBe("expr");
    const wide = suggest("recieve the mail", "y", { id: "wide" });
    expect(pickSuggestion([wide, a])?.id).toBe(a.id);
    expect(pickSuggestion([])).toBeNull();
  });
});

describe("suggestionForCaret", () => {
  it("takes the suggestion under the caret, including its edges", () => {
    expect(suggestionForCaret(all, a.start + 2)?.id).toBe(a.id);
    expect(suggestionForCaret(all, a.start)?.id).toBe(a.id);
    expect(suggestionForCaret(all, a.end)?.id).toBe(a.id);
  });

  it("otherwise takes the next one in the text, and wraps after the last", () => {
    expect(suggestionForCaret(all, a.end + 2)?.id).toBe(b.id);
    expect(suggestionForCaret(all, c.end + 1)?.id).toBe(a.id);
    expect(suggestionForCaret([], 3)).toBeNull();
  });
});

describe("stepping through suggestions", () => {
  it("goes in reading order, wraps in both directions and starts from an unknown id", () => {
    expect(stepSuggestion(all, a.id, 1)?.id).toBe(b.id);
    expect(stepSuggestion(all, b.id, 1)?.id).toBe(c.id);
    expect(stepSuggestion(all, c.id, 1)?.id).toBe(a.id);
    expect(stepSuggestion(all, a.id, -1)?.id).toBe(c.id);
    expect(stepSuggestion(all, "gone", 1)?.id).toBe(a.id);
    expect(stepSuggestion(all, "gone", -1)?.id).toBe(c.id);
    expect(stepSuggestion([], "x", 1)).toBeNull();
    expect(sortedIndex(all, b.id)).toBe(1);
  });
});

describe("popover keyboard flow", () => {
  const open: PopoverState = { id: a.id, via: "keyboard" };

  it("opens only for a suggestion that exists", () => {
    expect(popoverReducer(null, { type: "open", id: b.id, via: "pointer" }, all)).toEqual({ id: b.id, via: "pointer" });
    expect(popoverReducer(null, { type: "open", id: "nope", via: "pointer" }, all)).toBeNull();
  });

  it("Tab and Shift+Tab move to the next and previous suggestion and count as keyboard use", () => {
    const pointer: PopoverState = { id: a.id, via: "pointer" };
    expect(popoverReducer(pointer, { type: "step", direction: 1 }, all)).toEqual({ id: b.id, via: "keyboard" });
    expect(popoverReducer(open, { type: "step", direction: -1 }, all)).toEqual({ id: c.id, via: "keyboard" });
    expect(popoverReducer(null, { type: "step", direction: 1 }, all)).toBeNull();
  });

  it("Escape closes without deciding anything", () => {
    expect(popoverReducer(open, { type: "close" }, all)).toBeNull();
  });

  it("after Apply the keyboard goes on to the next suggestion; the pointer closes", () => {
    expect(popoverReducer(open, { type: "decided", applied: true }, all)).toEqual({ id: b.id, via: "keyboard" });
    expect(popoverReducer({ id: a.id, via: "pointer" }, { type: "decided", applied: true }, all)).toBeNull();
  });

  it("after the last suggestion it wraps to the first one that is left, then closes", () => {
    expect(popoverReducer({ id: c.id, via: "keyboard" }, { type: "decided", applied: false }, all)).toEqual({
      id: a.id,
      via: "keyboard",
    });
    expect(popoverReducer(open, { type: "decided", applied: true }, [a])).toBeNull();
  });

  it("does not go to a suggestion the applied one overlaps, but may after a dismissal", () => {
    const inside = suggest("the mail", "post", { id: "inside" });
    const list = [a, inside, b];
    const wide = suggest("recieve the mail", "receive the post", { id: "wide" });
    const withWide = [wide, inside, b];
    expect(popoverReducer({ id: "wide", via: "keyboard" }, { type: "decided", applied: true }, withWide)).toEqual({
      id: b.id,
      via: "keyboard",
    });
    expect(popoverReducer({ id: a.id, via: "keyboard" }, { type: "decided", applied: false }, list)).toEqual({
      id: "inside",
      via: "keyboard",
    });
  });

  it("walks a whole document with Enter: each Apply leaves the next suggestion open and the text correct", () => {
    let doc = createDoc(TEXT, all);
    let popover: PopoverState = popoverReducer(null, { type: "open", id: doc.suggestions[0].id, via: "keyboard" }, doc.suggestions);
    const seen: string[] = [];
    while (popover) {
      seen.push(popover.id);
      const next: PopoverState = popoverReducer(popover, { type: "decided", applied: true }, doc.suggestions);
      doc = editorReducer(doc, { type: "apply", id: popover.id });
      popover = next ? syncPopover(next, doc.suggestions) : null;
    }
    expect(seen).toEqual([a.id, b.id, c.id]);
    expect(doc.text).toBe("I receive the mail. It was unfortunately late. We went home.");
  });

  it("closes a popover whose suggestion disappeared", () => {
    expect(syncPopover(open, all)).toEqual(open);
    expect(syncPopover(open, [b, c])).toBeNull();
    expect(syncPopover(null, all)).toBeNull();
  });
});

describe("placePopover", () => {
  const container = { width: 800, height: 600 };
  const size = { width: 320, height: 150 };

  it("sits under the word, aligned with its left edge", () => {
    expect(placePopover({ left: 100, top: 40, right: 160, bottom: 62 }, container, size)).toEqual({
      left: 100,
      top: 70,
      placement: "below",
    });
  });

  it("flips above the word when there is no room below", () => {
    expect(placePopover({ left: 100, top: 500, right: 160, bottom: 522 }, container, size)).toEqual({
      left: 100,
      top: 342,
      placement: "above",
    });
  });

  it("stays inside the container horizontally", () => {
    expect(placePopover({ left: 700, top: 40, right: 760, bottom: 62 }, container, size).left).toBe(472);
    expect(placePopover({ left: -30, top: 40, right: 20, bottom: 62 }, container, size).left).toBe(8);
  });

  it("falls back to the lowest position that fits when neither side has room", () => {
    const tight = { width: 800, height: 200 };
    const placed = placePopover({ left: 100, top: 90, right: 160, bottom: 112 }, tight, size);
    expect(placed.top).toBe(42);
  });
});

describe("popover markup", () => {
  const noop = () => {};
  function render(suggestion: Suggestion, overrides: Partial<Parameters<typeof InlinePopover>[0]> = {}) {
    return renderToStaticMarkup(
      createElement(InlinePopover, {
        suggestion,
        text: TEXT,
        index: 0,
        count: 3,
        via: "pointer",
        getAnchor: () => null,
        reveal: noop,
        layoutKey: 0,
        onApply: noop,
        onDismiss: noop,
        onStep: noop,
        onClose: noop,
        onLost: noop,
        ...overrides,
      }),
    );
  }

  it("shows the replacement, the reason, Apply and Dismiss", () => {
    const html = render(a);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("recieve");
    expect(html).toContain("receive");
    expect(html).toContain("Spelling.");
    expect(html).toContain(">Apply<");
    expect(html).toContain(">Dismiss<");
    expect(html).toContain("1 of 3");
    expect(html).toContain("Tab next");
    expect(html).not.toContain("Changes meaning");
  });

  it("warns when the edit changes the meaning", () => {
    expect(render(suggest("goed", "went", { meaningChange: true }))).toContain("Changes meaning. Check it still says what you mean.");
  });

  it("is a sheet on narrow screens and floats from the pop-up position otherwise", () => {
    const html = render(a);
    expect(html).toContain("@max-xl:relative");
    expect(html).toContain("left-(--pop-left)");
  });
});

describe("rail: Fix all safe errors", () => {
  const noop = () => {};
  function rail(props: Partial<Parameters<typeof SuggestionRail>[0]> = {}) {
    return renderToStaticMarkup(
      createElement(SuggestionRail, {
        suggestions: all,
        text: TEXT,
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

  it("offers the button with the count when two or more safe errors are waiting", () => {
    const html = rail({ safeCount: 3 });
    expect(html).toContain("Fix all safe errors (3)");
    expect(html).toContain("Skips changes to numbers, names and negation.");
  });

  it("hides it for fewer than two", () => {
    expect(rail({ safeCount: 1 })).not.toContain("Fix all safe errors");
    expect(rail()).not.toContain("Fix all safe errors");
  });

  it("tells how to open a suggestion in the text", () => {
    expect(rail()).toContain("Click an underline, or press Alt+Enter");
  });
});
