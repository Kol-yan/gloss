import { describe, expect, it } from "vitest";
import {
  canUndo,
  createDoc,
  editorReducer,
  rebaseSuggestions,
  type EditorDoc,
} from "@/features/editor/editor-reducer";
import { buildSegments } from "@/features/editor/highlight";
import type { Suggestion } from "@/shared/contracts";

function suggest(text: string, fragment: string, replacement: string, overrides: Partial<Suggestion> = {}): Suggestion {
  const start = text.indexOf(fragment);
  if (start === -1) throw new Error(`fragment not found: ${fragment}`);
  return {
    id: overrides.id ?? `s-${fragment}`,
    source: "local",
    category: "error",
    start,
    end: start + fragment.length,
    original: fragment,
    replacement,
    reason: "test",
    meaningChange: false,
    ...overrides,
  };
}

const TEXT = "I recieve the mail. It was unfortunatelly late.";

function docWithBoth(): EditorDoc {
  return createDoc(TEXT, [suggest(TEXT, "recieve", "receive"), suggest(TEXT, "unfortunatelly", "unfortunately")]);
}

describe("rebaseSuggestions", () => {
  it("shifts suggestions after an edit and keeps those before it", () => {
    const next = "Well, " + TEXT;
    const rebased = rebaseSuggestions(TEXT, next, docWithBoth().suggestions);
    expect(rebased).toHaveLength(2);
    for (const s of rebased) expect(next.slice(s.start, s.end)).toBe(s.original);
  });

  it("drops a suggestion when the edit touches its words", () => {
    const next = TEXT.replace("recieve", "recieved");
    const rebased = rebaseSuggestions(TEXT, next, docWithBoth().suggestions);
    expect(rebased.map((s) => s.original)).toEqual(["unfortunatelly"]);
  });

  it("keeps a suggestion when a space is typed right after it", () => {
    const text = "I recieve";
    const next = "I recieve ";
    expect(rebaseSuggestions(text, next, [suggest(text, "recieve", "receive")])).toHaveLength(1);
  });

  it("drops a suggestion when a letter is glued onto it", () => {
    const text = "I recieve";
    const next = "I recieves";
    expect(rebaseSuggestions(text, next, [suggest(text, "recieve", "receive")])).toHaveLength(0);
  });
});

describe("editorReducer", () => {
  it("drops suggestions that can no longer be applied when the text changes", () => {
    const doc = docWithBoth();
    const next = editorReducer(doc, { type: "edit", text: TEXT.replace("unfortunatelly", "sadly") });
    expect(next.suggestions.map((s) => s.original)).toEqual(["recieve"]);
  });

  it("applies a suggestion, keeps the others valid and allows undo", () => {
    const doc = docWithBoth();
    const applied = editorReducer(doc, { type: "apply", id: "s-recieve" });
    expect(applied.text).toBe("I receive the mail. It was unfortunatelly late.");
    expect(applied.suggestions).toHaveLength(1);
    expect(applied.suggestions[0].original).toBe("unfortunatelly");
    expect(canUndo(applied)).toBe(true);

    const undone = editorReducer(applied, { type: "undo" });
    expect(undone.text).toBe(TEXT);
    expect(undone.suggestions.map((s) => s.original).sort()).toEqual(["recieve", "unfortunatelly"]);
    expect(canUndo(undone)).toBe(false);
  });

  it("undoes several applications in reverse order", () => {
    let doc = docWithBoth();
    doc = editorReducer(doc, { type: "apply", id: "s-recieve" });
    doc = editorReducer(doc, { type: "apply", id: "s-unfortunatelly" });
    expect(doc.text).toBe("I receive the mail. It was unfortunately late.");
    doc = editorReducer(doc, { type: "undo" });
    expect(doc.text).toBe("I receive the mail. It was unfortunatelly late.");
    doc = editorReducer(doc, { type: "undo" });
    expect(doc.text).toBe(TEXT);
  });

  it("never undoes over text the learner typed afterwards", () => {
    let doc = docWithBoth();
    doc = editorReducer(doc, { type: "apply", id: "s-recieve" });
    doc = editorReducer(doc, { type: "edit", text: doc.text + " Thanks." });
    expect(canUndo(doc)).toBe(false);
    const after = editorReducer(doc, { type: "undo" });
    expect(after.text).toBe(doc.text);
  });

  it("removes overlapping suggestions when one is applied", () => {
    const text = "I recieve it";
    const doc = createDoc(text, [
      suggest(text, "recieve", "receive", { id: "a" }),
      suggest(text, "I recieve", "I received", { id: "b", category: "style" }),
    ]);
    const next = editorReducer(doc, { type: "apply", id: "a" });
    expect(next.suggestions).toHaveLength(0);
  });

  it("does not resurrect dismissed suggestions on later results", () => {
    let doc = docWithBoth();
    doc = editorReducer(doc, { type: "dismiss", id: "s-recieve" });
    expect(doc.suggestions).toHaveLength(1);
    doc = editorReducer(doc, {
      type: "receive",
      source: "local",
      forText: doc.text,
      suggestions: [suggest(TEXT, "recieve", "receive"), suggest(TEXT, "unfortunatelly", "unfortunately")],
    });
    expect(doc.suggestions.map((s) => s.original)).toEqual(["unfortunatelly"]);
  });

  it("replaces suggestions of one source and keeps the other", () => {
    let doc = docWithBoth();
    const ai = suggest(TEXT, "the mail", "my mail", { id: "ai-1", source: "ai", category: "style" });
    doc = editorReducer(doc, { type: "receive", source: "ai", forText: TEXT, suggestions: [ai] });
    expect(doc.suggestions).toHaveLength(3);
    doc = editorReducer(doc, { type: "receive", source: "ai", forText: TEXT, suggestions: [] });
    expect(doc.suggestions.map((s) => s.source)).toEqual(["local", "local"]);
  });

  it("shows a fix reported by both sources once, as the local one", () => {
    const doc = docWithBoth();
    const duplicate = suggest(TEXT, "recieve", "receive", { id: "ai-dup", source: "ai" });
    const next = editorReducer(doc, { type: "receive", source: "ai", forText: TEXT, suggestions: [duplicate] });
    expect(next.suggestions.filter((s) => s.original === "recieve")).toHaveLength(1);
    expect(next.suggestions.find((s) => s.original === "recieve")?.source).toBe("local");
  });

  it("rebases results that were computed for older text", () => {
    const doc = createDoc("Hello. " + TEXT);
    const stale = suggest(TEXT, "recieve", "receive", { id: "late", source: "ai" });
    const next = editorReducer(doc, { type: "receive", source: "ai", forText: TEXT, suggestions: [stale] });
    expect(next.suggestions).toHaveLength(1);
    expect(next.text.slice(next.suggestions[0].start, next.suggestions[0].end)).toBe("recieve");
  });

  it("ignores results that no longer fit the text", () => {
    const doc = createDoc("Something else entirely.");
    const next = editorReducer(doc, {
      type: "receive",
      source: "ai",
      forText: TEXT,
      suggestions: [suggest(TEXT, "recieve", "receive", { source: "ai" })],
    });
    expect(next.suggestions).toHaveLength(0);
  });
});

describe("buildSegments", () => {
  it("marks suggestion ranges and keeps plain text between them", () => {
    const doc = docWithBoth();
    const segments = buildSegments(doc.text, doc.suggestions, null);
    expect(segments.map((s) => s.text).join("")).toBe(TEXT);
    expect(segments.filter((s) => s.category).map((s) => s.text)).toEqual(["recieve", "unfortunatelly"]);
  });

  it("flags the active suggestion and lets errors win over style when ranges overlap", () => {
    const text = "I recieve it";
    const suggestions = [
      suggest(text, "recieve", "receive", { id: "a" }),
      suggest(text, "I recieve", "I received", { id: "b", category: "style" }),
    ];
    const plain = buildSegments(text, suggestions, null);
    expect(plain.find((s) => s.text === "recieve")?.category).toBe("error");
    expect(plain.find((s) => s.text === "I ")?.category).toBe("style");
    const active = buildSegments(text, suggestions, "b");
    expect(active.find((s) => s.text === "recieve")?.category).toBe("style");
    expect(active.every((s) => s.category === null || s.active)).toBe(true);
  });
});
