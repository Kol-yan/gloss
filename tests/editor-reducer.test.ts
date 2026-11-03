import { describe, expect, it, vi } from "vitest";
import {
  NO_APPLIED,
  canUndo,
  createDoc,
  editorReducer,
  rebaseSuggestions,
  reportApplied,
  sentenceRangesTouching,
  type EditorDoc,
} from "@/features/editor/editor-reducer";
import { buildSegments } from "@/features/editor/highlight";
import { splitSentences } from "@/lib/text";
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
    meaning: null,
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

  it("treats a wider cloud suggestion with the same effect as a duplicate", () => {
    const text = "An apple and a orange.";
    const doc = createDoc(text, [suggest(text, "a", "an", { id: "l", start: 13, end: 14 })]);
    const wide = suggest(text, "a orange", "an orange", { id: "ai-wide", source: "ai" });
    const next = editorReducer(doc, { type: "receive", source: "ai", forText: text, suggestions: [wide] });
    expect(next.suggestions.map((s) => s.id)).toEqual(["l"]);
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

describe("stale cloud suggestions", () => {
  const ai = (text: string, fragment: string, replacement: string, id: string) =>
    suggest(text, fragment, replacement, { id, source: "ai" });

  it("reports cloud suggestions that disappear after an edit, once per batch", () => {
    const doc = createDoc(TEXT, [ai(TEXT, "recieve", "receive", "a1"), ai(TEXT, "unfortunatelly", "unfortunately", "a2")]);
    const next = editorReducer(doc, { type: "edit", text: TEXT.replace("recieve", "recieved") });
    expect(next.stale.items.map((s) => s.id)).toEqual(["a1"]);
    expect(next.stale.text).toBe(TEXT);
    // A following edit that removes nothing clears the batch.
    const after = editorReducer(next, { type: "edit", text: next.text + " Ok." });
    expect(after.stale.items).toHaveLength(0);
  });

  it("does not report local suggestions or the one the learner decided on", () => {
    const doc = createDoc(TEXT, [suggest(TEXT, "recieve", "receive"), ai(TEXT, "unfortunatelly", "unfortunately", "a2")]);
    expect(editorReducer(doc, { type: "edit", text: TEXT.replace("recieve", "x") }).stale.items).toHaveLength(0);
    expect(editorReducer(doc, { type: "dismiss", id: "a2" }).stale.items).toHaveLength(0);
    expect(editorReducer(doc, { type: "apply", id: "a2" }).stale.items).toHaveLength(0);
  });

  it("reports cloud suggestions removed because another fix overlapped them", () => {
    const text = "I recieve it";
    const doc = createDoc(text, [
      ai(text, "recieve", "receive", "a"),
      ai(text, "I recieve", "I received", "b"),
    ]);
    expect(editorReducer(doc, { type: "apply", id: "a" }).stale.items.map((s) => s.id)).toEqual(["b"]);
  });

  it("reports older cloud suggestions replaced by a new check", () => {
    const doc = createDoc(TEXT, [ai(TEXT, "recieve", "receive", "old")]);
    const next = editorReducer(doc, { type: "receive", source: "ai", forText: TEXT, suggestions: [] });
    expect(next.stale.items.map((s) => s.id)).toEqual(["old"]);
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

describe("after applying a suggestion", () => {
  const text = "I recieve the mail. It was unfortunatelly late. We goed home yesterday.";
  const cloud = (fragment: string, replacement: string, id: string) =>
    suggest(text, fragment, replacement, { id, source: "ai" });
  const threeCloud = () =>
    createDoc(text, [cloud("recieve", "receive", "a"), cloud("unfortunatelly", "unfortunately", "b"), cloud("goed", "went", "c")]);

  it("keeps the other cloud suggestions through a local re-check and a later edit", () => {
    let doc = editorReducer(threeCloud(), { type: "apply", id: "a" });
    expect(doc.suggestions.map((s) => s.id)).toEqual(["b", "c"]);

    // The local checker answers for the new text and reports nothing.
    doc = editorReducer(doc, { type: "receive", source: "local", forText: doc.text, suggestions: [] });
    expect(doc.suggestions.map((s) => s.id)).toEqual(["b", "c"]);
    expect(doc.stale.items).toHaveLength(0);

    doc = editorReducer(doc, { type: "edit", text: doc.text + " Thanks." });
    expect(doc.suggestions.map((s) => s.id)).toEqual(["b", "c"]);
    for (const s of doc.suggestions) expect(doc.text.slice(s.start, s.end)).toBe(s.original);
  });

  it("shifts later suggestions by exactly the applied length change", () => {
    const longer = editorReducer(threeCloud(), { type: "apply", id: "b" });
    expect(longer.text).toContain("unfortunately late");
    const goed = longer.suggestions.find((s) => s.id === "c");
    expect(goed).toMatchObject({ start: longer.text.indexOf("goed"), end: longer.text.indexOf("goed") + 4 });

    const shorter = editorReducer(threeCloud(), { type: "apply", id: "c" });
    expect(shorter.suggestions.map((s) => s.id)).toEqual(["a", "b"]);
    const mail = editorReducer(
      createDoc(text, [cloud("recieve the mail", "get it", "wide"), cloud("goed", "went", "c")]),
      { type: "apply", id: "wide" },
    );
    expect(mail.suggestions.map((s) => mail.text.slice(s.start, s.end))).toEqual(["goed"]);
  });

  it("keeps a suggestion that starts exactly where the applied one ends", () => {
    const glued = "Enor,ous help";
    const doc = createDoc(glued, [
      suggest(glued, "Enor", "Enos", { id: "word" }),
      suggest(glued, ",", ", ", { id: "comma", category: "style" }),
      suggest(glued, "ous", "opus", { id: "tail" }),
    ]);
    const next = editorReducer(doc, { type: "apply", id: "word" });
    expect(next.text).toBe("Enos,ous help");
    expect(next.suggestions.map((s) => s.id)).toEqual(["comma", "tail"]);
    for (const s of next.suggestions) expect(next.text.slice(s.start, s.end)).toBe(s.original);
  });

  it("keeps a suggestion that ends exactly where the applied one starts", () => {
    const glued = "Hello,wrld there";
    const doc = createDoc(glued, [
      suggest(glued, ",", ", ", { id: "comma", category: "style" }),
      suggest(glued, "wrld", "world", { id: "word" }),
    ]);
    const next = editorReducer(doc, { type: "apply", id: "word" });
    expect(next.suggestions.map((s) => s.id)).toEqual(["comma"]);
  });
});

describe("sentences changed by an applied cloud suggestion", () => {
  const text = "I recieve the mail. It was unfortunatelly late. We goed home yesterday.";
  const ai = (fragment: string, replacement: string, id: string) =>
    suggest(text, fragment, replacement, { id, source: "ai" });

  it("reports only the sentence the edit is in, as a range into the new text", () => {
    const doc = createDoc(text, [ai("unfortunatelly", "unfortunately", "b")]);
    const next = editorReducer(doc, { type: "apply", id: "b" });
    const second = splitSentences(next.text)[1];
    expect(next.applied.ranges).toEqual([{ start: second.start, end: second.end }]);
    expect(next.applied.text).toBe(next.text);
    expect(next.text.slice(second.start, second.end)).toBe("It was unfortunately late.");
  });

  it("reports every sentence a wide edit spans", () => {
    const doc = createDoc(text, [ai("late. We goed", "late. Then we went", "wide")]);
    const next = editorReducer(doc, { type: "apply", id: "wide" });
    expect(next.applied.ranges).toHaveLength(2);
  });

  it("reports nothing for a local fix, an edit, an undo or an unusable apply", () => {
    const local = createDoc(text, [suggest(text, "recieve", "receive", { id: "l" })]);
    expect(editorReducer(local, { type: "apply", id: "l" }).applied).toBe(NO_APPLIED);

    const cloud = createDoc(text, [ai("goed", "went", "c")]);
    const applied = editorReducer(cloud, { type: "apply", id: "c" });
    expect(applied.applied.ranges).toHaveLength(1);
    expect(editorReducer(applied, { type: "edit", text: applied.text + " Ok." }).applied).toBe(NO_APPLIED);
    expect(editorReducer(applied, { type: "undo" }).applied).toBe(NO_APPLIED);
    expect(editorReducer(cloud, { type: "apply", id: "missing" }).applied).toBe(NO_APPLIED);
  });

  it("finds the sentence around an empty edit", () => {
    const t = "One. Two words.";
    expect(sentenceRangesTouching(t, 9, 9)).toEqual([{ start: 5, end: 15 }]);
  });

  it("passes each applied batch to the re-check hook once, with the applied sentence range", () => {
    const doc = createDoc(text, [ai("goed", "went", "c")]);
    const next = editorReducer(doc, { type: "apply", id: "c" });
    const third = splitSentences(next.text)[2];
    const recheck = vi.fn();

    let reported = reportApplied(doc.applied, next.applied, recheck);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(recheck).toHaveBeenCalledWith([{ start: third.start, end: third.end }], next.text);

    // The same batch seen again (a re-render) and the empty batch that follows an edit do nothing.
    reported = reportApplied(reported, next.applied, recheck);
    reportApplied(reported, NO_APPLIED, recheck);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(() => reportApplied(NO_APPLIED, next.applied, undefined)).not.toThrow();
  });
});


describe("cloud suggestions for one sentence", () => {
  const text = "I recieve the mail. It was unfortunatelly late. We goed home yesterday.";
  const cloud = (fragment: string, replacement: string, id: string, overrides: Partial<Suggestion> = {}) =>
    suggest(text, fragment, replacement, { id, source: "ai", ...overrides });
  const second = splitSentences(text)[1];

  it("replaces the cloud suggestions inside that sentence and leaves the others alone", () => {
    const doc = createDoc(text, [
      cloud("recieve", "receive", "a"),
      cloud("unfortunatelly", "unfortunately", "old"),
      cloud("goed", "went", "c"),
      suggest(text, "mail", "post", { id: "local-mail" }),
    ]);
    const fresh = cloud("unfortunatelly", "regrettably", "new");
    const next = editorReducer(doc, {
      type: "receiveSentence",
      sentenceText: second.text,
      start: second.start,
      end: second.end,
      suggestions: [fresh],
    });
    expect(next.suggestions.map((s) => s.id)).toEqual(["a", "local-mail", "new", "c"]);
    expect(next.stale.items.map((s) => s.id)).toEqual(["old"]);
  });

  it("keeps suggestions in other sentences when the answer is empty", () => {
    const doc = createDoc(text, [cloud("recieve", "receive", "a"), cloud("goed", "went", "c")]);
    const next = editorReducer(doc, { type: "receiveSentence", sentenceText: second.text, start: second.start, end: second.end, suggestions: [] });
    expect(next.suggestions.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("drops the answer when the sentence changed on its way", () => {
    const doc = createDoc(text);
    const edited = editorReducer(doc, { type: "edit", text: text.replace("It was", "It is") });
    const next = editorReducer(edited, {
      type: "receiveSentence",
      sentenceText: second.text,
      start: second.start,
      end: second.end,
      suggestions: [cloud("unfortunatelly", "unfortunately", "x")],
    });
    expect(next).toBe(edited);
  });

  it("ignores suggestions outside the sentence, local ones, dismissed ones and duplicates of a local fix", () => {
    let doc = createDoc(text, [suggest(text, "unfortunatelly", "unfortunately", { id: "local-1" })]);
    doc = editorReducer(doc, {
      type: "receiveSentence",
      sentenceText: second.text,
      start: second.start,
      end: second.end,
      suggestions: [
        cloud("recieve", "receive", "outside"),
        cloud("unfortunatelly", "unfortunately", "dup"),
        cloud("late", "delayed", "ai-late"),
        suggest(text, "was", "is", { id: "wrong-source" }),
      ],
    });
    expect(doc.suggestions.map((s) => s.id)).toEqual(["local-1", "ai-late"]);

    doc = editorReducer(doc, { type: "dismiss", id: "ai-late" });
    doc = editorReducer(doc, {
      type: "receiveSentence",
      sentenceText: second.text,
      start: second.start,
      end: second.end,
      suggestions: [cloud("late", "delayed", "ai-late-again")],
    });
    expect(doc.suggestions.map((s) => s.id)).toEqual(["local-1"]);
  });

  it("keeps every other highlight when a fix is applied and the changed sentence is asked about again", () => {
    let doc = createDoc(text, [cloud("recieve", "receive", "a"), cloud("unfortunatelly", "unfortunately", "b"), cloud("goed", "went", "c")]);
    doc = editorReducer(doc, { type: "apply", id: "a" });
    expect(doc.suggestions.map((s) => s.id)).toEqual(["b", "c"]);
    expect(doc.applied.ranges).toHaveLength(1);
    for (const s of doc.suggestions) expect(doc.text.slice(s.start, s.end)).toBe(s.original);
  });
});

describe("buildSegments with sentence flags", () => {
  const text = "I go to school every day. She like apples very much.";
  const flag = {
    id: "f".repeat(64),
    start: 26,
    end: text.length,
    text: "She like apples very much.",
    categories: ["correction", "word_choice"] as ("correction" | "word_choice")[],
    scores: { correction: 0.9, clarity: 0, word_choice: 0.7 },
  };

  it("marks the whole flagged sentence with its first badge category", () => {
    const segments = buildSegments(text, [], null, [flag]);
    expect(segments.map((s) => s.text).join("")).toBe(text);
    const flagged = segments.filter((s) => s.flag);
    expect(flagged.map((s) => s.text).join("")).toBe("She like apples very much.");
    expect(flagged.every((s) => s.flag === "correction" && s.flagId === flag.id)).toBe(true);
    expect(segments.find((s) => s.text.startsWith("I go"))?.flag).toBeNull();
  });

  it("keeps word-level suggestions inside a flagged sentence and highlights it when its card is active", () => {
    const s = suggest(text, "like", "likes", { id: "w" });
    const segments = buildSegments(text, [s], null, [flag], flag.id);
    const word = segments.find((seg) => seg.text === "like");
    expect(word).toMatchObject({ category: "error", flag: "correction", flagActive: true });
    expect(segments.filter((seg) => seg.flag).every((seg) => seg.flagActive)).toBe(true);
  });
});
