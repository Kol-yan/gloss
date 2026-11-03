// Turns a suggestion into what its card shows: the smallest visible edit, a few
// words of context on each side and, for punctuation and spacing edits, a plain
// label such as "Add a space after the comma". Pure, so the wording is tested
// without a browser.
import { canApply } from "@/lib/text";
import type { Suggestion } from "@/shared/contracts";

export type ChangeView = {
  // Text before and after the edit. A leading or trailing ellipsis means the
  // snippet was cut. Both are empty when the suggestion no longer fits the text.
  before: string;
  after: string;
  // The smallest edit, widened to whole words when it cuts through one.
  removed: string;
  added: string;
  // Set only for edits made of spaces and punctuation, which are hard to see.
  label: string | null;
};

const WORD_CHAR = /[\p{L}\p{N}_'’]/u;
const HAS_WORD = /[\p{L}\p{N}]/u;

const CONTEXT_WORDS = 3;
const CONTEXT_CHARS = 36;

const PUNCTUATION: Record<string, { name: string; article: "a" | "an" }> = {
  ",": { name: "comma", article: "a" },
  ".": { name: "period", article: "a" },
  ";": { name: "semicolon", article: "a" },
  ":": { name: "colon", article: "a" },
  "!": { name: "exclamation mark", article: "an" },
  "?": { name: "question mark", article: "a" },
  "'": { name: "apostrophe", article: "an" },
  "’": { name: "apostrophe", article: "an" },
  "-": { name: "hyphen", article: "a" },
  "–": { name: "dash", article: "a" },
  "—": { name: "dash", article: "a" },
  "(": { name: "opening bracket", article: "an" },
  ")": { name: "closing bracket", article: "a" },
  '"': { name: "quotation mark", article: "a" },
  "“": { name: "opening quotation mark", article: "an" },
  "”": { name: "closing quotation mark", article: "a" },
};

function isWord(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

function contextBefore(text: string, end: number): string {
  const lineStart = text.lastIndexOf("\n", end - 1) + 1;
  let i = end;
  let words = 0;
  while (i > lineStart && end - i < CONTEXT_CHARS) {
    // Stepping from a word back onto the space before it completes one word.
    if (isSpace(text[i - 1]) && i < end && !isSpace(text[i])) {
      words += 1;
      if (words >= CONTEXT_WORDS) break;
    }
    i -= 1;
  }
  // A cut through the middle of a word is moved forward to the next space.
  if (i > lineStart && !isSpace(text[i - 1]) && !isSpace(text[i])) {
    let next = i;
    while (next < end && !isSpace(text[next])) next += 1;
    if (next < end) i = next;
  }
  const snippet = text.slice(i, end).trimStart();
  return (i > lineStart ? "…" : "") + snippet;
}

function contextAfter(text: string, start: number): string {
  let lineEnd = text.indexOf("\n", start);
  if (lineEnd === -1) lineEnd = text.length;
  let i = start;
  let words = 0;
  while (i < lineEnd && i - start < CONTEXT_CHARS) {
    if (isSpace(text[i]) && i > start && !isSpace(text[i - 1])) {
      words += 1;
      if (words >= CONTEXT_WORDS) break;
    }
    i += 1;
  }
  if (i < lineEnd && !isSpace(text[i - 1]) && !isSpace(text[i])) {
    let back = i;
    while (back > start && !isSpace(text[back - 1])) back -= 1;
    if (back > start) i = back;
  }
  const snippet = text.slice(start, i).trimEnd();
  return snippet + (i < lineEnd ? "…" : "");
}

function nameOf(ch: string): string | null {
  return PUNCTUATION[ch]?.name ?? null;
}

function withArticle(ch: string): string | null {
  const entry = PUNCTUATION[ch];
  return entry ? `${entry.article} ${entry.name}` : null;
}

// Marks that take a space after them, and marks that take one before them.
const SPACE_AFTER = new Set([",", ".", ";", ":", "!", "?", ")", "”"]);
const SPACE_BEFORE = new Set(["(", "“"]);

// A plain-language name for edits that only add, remove or swap one space or
// punctuation mark. `prev` and `next` are the characters around the edit.
function labelFor(removed: string, added: string, prev: string | undefined, next: string | undefined): string | null {
  if (HAS_WORD.test(removed + added)) return null;
  const addedSpace = added !== "" && added.trim() === "";
  const removedSpace = removed !== "" && removed.trim() === "";

  if (removed === "" && addedSpace) {
    const after = prev !== undefined && SPACE_AFTER.has(prev) ? nameOf(prev) : null;
    if (after) return `Add a space after the ${after}`;
    const before = next !== undefined && SPACE_BEFORE.has(next) ? nameOf(next) : null;
    if (before) return `Add a space before the ${before}`;
    // Splitting a word in two ("alot" -> "a lot") reads best as the words themselves.
    return isWord(prev) && isWord(next) ? null : "Add a space";
  }

  if (addedSpace && removedSpace) return "Use a single space";

  if (added === "" && removedSpace) {
    const before = next !== undefined && SPACE_AFTER.has(next) ? nameOf(next) : null;
    if (before) return `Remove the space before the ${before}`;
    // Joining two words ("can not" -> "cannot") reads best as the words themselves.
    return isWord(prev) && isWord(next) ? null : "Remove the extra space";
  }

  if (removed === "" && added.length === 1) {
    const name = withArticle(added);
    return name ? `Add ${name}` : null;
  }

  if (added === "" && removed.length === 1) {
    const name = nameOf(removed);
    return name ? `Remove the ${name}` : null;
  }

  if (added.length === 1 && removed.length === 1) {
    const to = withArticle(added);
    const from = nameOf(removed);
    return to && from ? `Change the ${from} to ${to}` : null;
  }

  return null;
}

export function describeChange(text: string, suggestion: Suggestion): ChangeView {
  const { original, replacement } = suggestion;
  // Without matching text there is nothing to show around the edit.
  if (!canApply(text, suggestion)) {
    return { before: "", after: "", removed: original, added: replacement, label: null };
  }

  const max = Math.min(original.length, replacement.length);
  let prefix = 0;
  while (prefix < max && original[prefix] === replacement[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    original[original.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]
  ) {
    suffix++;
  }

  let start = suggestion.start + prefix;
  let end = suggestion.end - suffix;
  let removed = original.slice(prefix, original.length - suffix);
  let added = replacement.slice(prefix, replacement.length - suffix);

  // An edit that cuts through a word ("a" -> "an") is shown as the whole word.
  const startsInWord = (removed === "" || isWord(removed[0])) && (added === "" || isWord(added[0]));
  const endsInWord = (removed === "" || isWord(removed.at(-1))) && (added === "" || isWord(added.at(-1)));
  let wordStart = start;
  let wordEnd = end;
  if (startsInWord) while (wordStart > 0 && isWord(text[wordStart - 1])) wordStart--;
  if (endsInWord) while (wordEnd < text.length && isWord(text[wordEnd])) wordEnd++;
  if (wordStart !== start || wordEnd !== end) {
    removed = text.slice(wordStart, start) + removed + text.slice(end, wordEnd);
    added = text.slice(wordStart, start) + added + text.slice(end, wordEnd);
    start = wordStart;
    end = wordEnd;
  }

  return {
    before: contextBefore(text, start),
    after: contextAfter(text, end),
    removed,
    added,
    label: labelFor(removed, added, text[start - 1], text[end]),
  };
}

export type SpacePart = { text: string; marker: boolean };

const MARKS: Record<string, string> = { " ": "␣", " ": "␣", "\n": "↵", "\t": "⇥" };

// Splits text so spaces that would be invisible on screen (at either end, doubled,
// or the whole string) can be drawn as markers. A single space between words
// stays an ordinary space.
export function splitSpaces(text: string): SpacePart[] {
  const parts: SpacePart[] = [];
  let last = 0;
  for (const match of text.matchAll(/\s+/g)) {
    const run = match[0];
    const at = match.index ?? 0;
    const atEdge = at === 0 || at + run.length === text.length;
    if (!atEdge && run === " ") continue;
    if (at > last) parts.push({ text: text.slice(last, at), marker: false });
    parts.push({ text: [...run].map((ch) => MARKS[ch] ?? "␣").join(""), marker: true });
    last = at + run.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), marker: false });
  return parts;
}

// How a fragment reads aloud, where a marker cannot be shown.
export function spoken(text: string): string {
  if (text === "") return "nothing";
  return splitSpaces(text)
    .map((part) => (part.marker ? (part.text.length === 1 ? "space" : "spaces") : part.text))
    .join(" ");
}
