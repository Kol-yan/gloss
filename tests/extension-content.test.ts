import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Content scripts are classic scripts that publish one global each; load
// them the way the browser does, in a context of their own.
function load<T>(file: string, name: string): T {
  const context: Record<string, unknown> = {};
  runInNewContext(readFileSync(`extension/content/${file}`, "utf8"), context);
  return context[name] as T;
}

type Word = { text: string; meaning: string };
type Match = { start: number; end: number; word: Word };
type Words = {
  buildWordMatcher(words: unknown): { size: number } | null;
  findWordMatches(matcher: unknown, text: string, limit?: number): Match[];
  isSkippedTag(tag: unknown): boolean;
};
type Suggestion = { id: string; category: string; start: number; end: number; original: string; replacement: string };
type Edits = {
  applySuggestion(text: string, s: Suggestion): string | null;
  checkableText(text: unknown): boolean;
  diffTexts(before: string, after: string): { start: number; oldEnd: number; newEnd: number } | null;
  dismissKey(s: Suggestion): string;
  fieldKind(field: unknown): string | null;
  locateOffset(segments: { start: number; length: number }[], offset: number, bias?: "start" | "end"): { index: number; offset: number } | null;
  rebaseSuggestions(list: Suggestion[], before: string, after: string): Suggestion[];
  suggestionAt(list: Suggestion[], offset: number): Suggestion | null;
  visibleSuggestions(list: Suggestion[], dismissed: Set<string>): Suggestion[];
};

const words = load<Words>("words.js", "glossWords");
const edits = load<Edits>("edits.js", "glossEdits");

// Plain copies, so results from the script's own realm compare by value.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function found(list: Word[], text: string): string[] {
  return words.findWordMatches(words.buildWordMatcher(list), text).map((m) => text.slice(m.start, m.end));
}

describe("highlighting the learner's words", () => {
  it("matches whole words in any case and carries the saved meaning", () => {
    const matcher = words.buildWordMatcher([{ text: "Serendipity", meaning: "a happy accident" }]);
    const text = "SERENDIPITY struck; serendipity again, but not serendipitys.";
    expect(plain(words.findWordMatches(matcher, text))).toEqual([
      { start: 0, end: 11, word: { text: "Serendipity", meaning: "a happy accident" } },
      { start: 20, end: 31, word: { text: "Serendipity", meaning: "a happy accident" } },
    ]);
  });

  it("does not match inside other words or across apostrophes", () => {
    expect(found([{ text: "don", meaning: "" }], "I don't know Don.")).toEqual(["Don"]);
    expect(found([{ text: "t", meaning: "" }], "don't")).toEqual([]);
    expect(found([{ text: "cat", meaning: "" }], "concatenate cats cat_ cat9 (cat)")).toEqual(["cat"]);
    expect(found([{ text: "known", meaning: "" }], "well-known")).toEqual(["known"]);
    expect(found([{ text: "café", meaning: "" }], "cafés café")).toEqual(["café"]);
  });

  it("matches phrases across any whitespace and prefers the longest entry", () => {
    const list = [{ text: "get", meaning: "" }, { text: "get the ball rolling", meaning: "start" }];
    expect(found(list, "Let's GET  the\nball rolling, then get going.")).toEqual(["GET  the\nball rolling", "get"]);
    expect(found([{ text: "well-known", meaning: "" }], "a well-known fact, a well known one")).toEqual(["well-known"]);
  });

  it("treats typographic and straight apostrophes alike", () => {
    expect(found([{ text: "rock 'n' roll", meaning: "" }], "rock ’n’ roll")).toEqual(["rock ’n’ roll"]);
    expect(found([{ text: "don’t", meaning: "" }], "I don't")).toEqual(["don't"]);
  });

  it("ignores entries that cannot be words and bounds the work", () => {
    expect(words.buildWordMatcher([])).toBeNull();
    expect(words.buildWordMatcher([{ text: "  " }, { text: "123" }, null, { meaning: "x" }, { text: "a".repeat(81) }])).toBeNull();
    expect(words.buildWordMatcher([{ text: "Word" }, { text: "word" }])?.size).toBe(1);
    const matcher = words.buildWordMatcher([{ text: "a", meaning: "" }]);
    expect(words.findWordMatches(matcher, "a a a a a", 2)).toHaveLength(2);
    expect(words.findWordMatches(null, "a")).toEqual([]);
  });

  it("skips text that is not prose", () => {
    for (const tag of ["SCRIPT", "style", "TEXTAREA", "INPUT", "code", "PRE", "svg"]) expect(words.isSkippedTag(tag)).toBe(true);
    for (const tag of ["P", "span", "A", "LI", undefined]) expect(words.isSkippedTag(tag)).toBe(false);
  });
});

describe("suggestions in a text field", () => {
  const s = (over: Partial<Suggestion>): Suggestion => ({ id: "s", category: "error", start: 0, end: 0, original: "", replacement: "", ...over });
  const teh = s({ id: "teh", start: 4, end: 7, original: "teh", replacement: "the" });
  const text = "Fix teh cat.";

  it("finds the single edit between two texts", () => {
    expect(edits.diffTexts("abc", "abc")).toBeNull();
    expect(plain(edits.diffTexts("Fix teh cat.", "Fix teh big cat."))).toEqual({ start: 8, oldEnd: 8, newEnd: 12 });
    expect(plain(edits.diffTexts("aaa", "aa"))).toEqual({ start: 2, oldEnd: 3, newEnd: 2 });
  });

  it("moves suggestions after an edit and keeps those before it", () => {
    expect(plain(edits.rebaseSuggestions([teh], text, "Please fix teh cat."))).toEqual([{ ...teh, start: 11, end: 14 }]);
    expect(plain(edits.rebaseSuggestions([teh], text, "Fix teh cat now."))).toEqual([teh]);
    expect(plain(edits.rebaseSuggestions([teh], text, text))).toEqual([teh]);
  });

  it("drops suggestions the learner edited or whose word grew", () => {
    expect(edits.rebaseSuggestions([teh], text, "Fix the cat.")).toEqual([]);
    expect(edits.rebaseSuggestions([teh], text, "Fix tehx cat.")).toEqual([]);
    expect(edits.rebaseSuggestions([teh], text, "Fix xteh cat.")).toEqual([]);
    expect(plain(edits.rebaseSuggestions([teh], text, "Fix teh  cat."))).toEqual([teh]);
    const insertion = s({ start: 3, end: 3, original: "", replacement: "," });
    expect(edits.rebaseSuggestions([insertion], "Yes I do.", "Yes, I do.")).toEqual([]);
  });

  it("applies a suggestion only where the text still matches", () => {
    expect(edits.applySuggestion(text, teh)).toBe("Fix the cat.");
    expect(edits.applySuggestion("Fix the cat.", teh)).toBeNull();
    expect(edits.applySuggestion("Fix", teh)).toBeNull();
    expect(edits.applySuggestion("Yes I do.", s({ start: 3, end: 3, replacement: "," }))).toBe("Yes, I do.");
  });

  it("shows corrections and style notes in order, without overlaps or dismissed ones", () => {
    const style = s({ id: "style", category: "style", start: 8, end: 11, original: "cat", replacement: "kitten" });
    const overlap = s({ id: "overlap", start: 5, end: 9, original: "eh c", replacement: "x" });
    const expression = s({ id: "expr", category: "expression", start: 0, end: 3, original: "Fix", replacement: "Mend" });
    const visible = edits.visibleSuggestions([style, overlap, teh, expression], new Set());
    expect(visible.map((v) => v.id)).toEqual(["teh", "style"]);
    expect(edits.visibleSuggestions([teh, style], new Set([edits.dismissKey(teh)])).map((v) => v.id)).toEqual(["style"]);
    expect(edits.suggestionAt(visible, 7)?.id).toBe("teh");
    expect(edits.suggestionAt(visible, 2)).toBeNull();
  });

  it("maps offsets in a rich text field to its text nodes", () => {
    // "Hello " + "world" in one paragraph, a line break, then "Next line".
    const segments = [{ start: 0, length: 6 }, { start: 6, length: 5 }, { start: 12, length: 9 }];
    expect(plain(edits.locateOffset(segments, 0))).toEqual({ index: 0, offset: 0 });
    expect(plain(edits.locateOffset(segments, 3))).toEqual({ index: 0, offset: 3 });
    // A boundary between two nodes: starts go forward, ends stay behind.
    expect(plain(edits.locateOffset(segments, 6, "start"))).toEqual({ index: 1, offset: 0 });
    expect(plain(edits.locateOffset(segments, 6, "end"))).toEqual({ index: 0, offset: 6 });
    // The end of a block, before its line break, and the start of the next block.
    expect(plain(edits.locateOffset(segments, 11, "start"))).toEqual({ index: 1, offset: 5 });
    expect(plain(edits.locateOffset(segments, 12, "start"))).toEqual({ index: 2, offset: 0 });
    expect(plain(edits.locateOffset(segments, 21, "end"))).toEqual({ index: 2, offset: 9 });
    expect(plain(edits.locateOffset(segments, 40, "end"))).toEqual({ index: 2, offset: 9 });
    // An offset inside a line break that belongs to no node goes to the next node.
    expect(plain(edits.locateOffset([{ start: 0, length: 2 }, { start: 4, length: 2 }], 3))).toEqual({ index: 1, offset: 0 });
    expect(edits.locateOffset([], 0)).toBeNull();
  });

  it("checks only real, normalized prose of a reasonable size", () => {
    expect(edits.checkableText("I has a cat.")).toBe(true);
    for (const value of ["Hi", "hello", "1234567890", "café is open now", "a\r\nb c d e f", "a ".repeat(3001), null]) {
      expect(edits.checkableText(value), String(value)).toBe(false);
    }
  });

  it("attaches to plain text fields and leaves sensitive or opted-out ones alone", () => {
    const field = (over: Record<string, unknown>) => ({ tag: "INPUT", type: "text", attributes: {}, ...over });
    expect(edits.fieldKind(field({ tag: "TEXTAREA" }))).toBe("textarea");
    expect(edits.fieldKind(field({}))).toBe("input");
    expect(edits.fieldKind(field({ type: "TEXT" }))).toBe("input");
    expect(edits.fieldKind(field({ tag: "DIV", isContentEditable: true }))).toBe("editable");
    expect(edits.fieldKind(field({ attributes: { autocomplete: "off" } }))).toBe("input");
    // Sites with their own proofreading switch the browser's spelling off;
    // that must not opt them out of gloss (translate.google.com does this).
    expect(edits.fieldKind(field({ tag: "TEXTAREA", attributes: { spellcheck: "false", autocomplete: "off" } }))).toBe("textarea");
    for (const over of [
      { type: "password" }, { type: "email" }, { type: "search" }, { type: "url" },
      { readOnly: true }, { disabled: true },
      { attributes: { autocomplete: "cc-number" } },
      { attributes: { autocomplete: "username" } }, { attributes: { "data-gloss": "off" } },
      { attributes: { "data-gramm": "false" } }, { attributes: { "data-enable-grammarly": "false" } },
      { tag: "DIV" }, { tag: "SELECT" },
      // Hidden keyboard sinks of Ace, Monaco and CodeMirror hold no DOM text.
      { tag: "TEXTAREA", inSeparateEditor: true },
      { tag: "DIV", isContentEditable: true, inSeparateEditor: true },
    ]) {
      expect(edits.fieldKind(field(over)), JSON.stringify(over)).toBeNull();
    }
    expect(edits.fieldKind(null)).toBeNull();
  });
});

describe("scrolled field underlines", () => {
  it.each(["input", "textarea"])("keeps the underline on goed in a horizontally scrolled %s", (kind) => {
    const text = "I went home and goed to sleep.";
    const start = text.indexOf("goed");
    const suggestion = { id: "goed", start, end: start + 4 };
    const mirror = {
      style: {} as Record<string, string>, scrollLeft: 40, scrollTop: 12,
      append: () => undefined, replaceChildren: () => undefined,
      getBoundingClientRect: () => ({ left: 10, top: 20 }),
    };
    const context: Record<string, unknown> = {
      glossUi: { mirrorElement: () => mirror },
      document: {
        createElement: () => ({
          textContent: "",
          // Monospace glyphs at their scrolled mirror position.
          getClientRects: () => [{ left: 10 + start * 10 - mirror.scrollLeft, top: 20 + 4 - mirror.scrollTop, width: 40, height: 18 }],
        }),
      },
      window: {},
    };
    // Expose the private measurement function only in this isolated test realm.
    const source = readFileSync("extension/content/checks.js", "utf8")
      .replace("globalThis.glossChecks = Object.freeze({", "globalThis.measureField = measureField; globalThis.glossChecks = Object.freeze({");
    runInNewContext(source, context);
    const measure = context.measureField as (state: unknown, area: unknown) => { rects: { left: number; top: number }[] }[];
    const element = { value: text, clientWidth: 200, clientHeight: 30, scrollLeft: 100, scrollTop: 2, wrap: "off" };
    const area = {
      left: 100, top: 50, right: 300, bottom: 80,
      style: { paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0", whiteSpace: "pre", overflowWrap: "normal", wordBreak: "normal" },
    };
    const marks = measure({ element, text, kind, suggestions: [suggestion] }, area);
    expect(marks[0].rects[0].left).toBe(100 + start * 10 - element.scrollLeft);
    expect(marks[0].rects[0].top).toBe(52);
    expect(mirror.style.whiteSpace).toBe("pre");
    // Scroll again without a new check: the same word must move with its field.
    element.scrollLeft = 130;
    expect(measure({ element, text, kind, suggestions: [suggestion] }, area)[0].rects[0].left)
      .toBe(100 + start * 10 - element.scrollLeft);
  });
});
