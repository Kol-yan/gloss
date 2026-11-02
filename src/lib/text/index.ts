// Text helpers shared by the editor and the server. All ranges are UTF-16
// indices (plain JavaScript string indices) into text produced by
// normalizeText, so client and server always address the same characters.

export function normalizeText(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n");
}

export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type Sentence = {
  index: number;
  start: number;
  end: number;
  text: string;
};

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

// Splits text into sentences with trailing whitespace trimmed from each range.
export function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  for (const segment of sentenceSegmenter.segment(text)) {
    const trimmed = segment.segment.trimEnd();
    const leading = trimmed.length - trimmed.trimStart().length;
    const body = trimmed.trimStart();
    if (!body) continue;
    const start = segment.index + leading;
    sentences.push({ index: sentences.length, start, end: start + body.length, text: body });
  }
  return sentences;
}

// Finds a fragment inside one sentence. Returns absolute indices only when the
// fragment occurs exactly once; ambiguous or missing fragments are rejected
// rather than guessed.
export function locateFragment(
  sentence: Sentence,
  fragment: string,
): { start: number; end: number } | null {
  if (!fragment) return null;
  const first = sentence.text.indexOf(fragment);
  if (first === -1) return null;
  if (sentence.text.indexOf(fragment, first + 1) !== -1) return null;
  const start = sentence.start + first;
  return { start, end: start + fragment.length };
}

type Range = { start: number; end: number; original: string; replacement: string };

// A suggestion may only be applied to the exact text it was computed for.
export function canApply(text: string, range: Range): boolean {
  return range.end <= text.length && text.slice(range.start, range.end) === range.original;
}

export function applyRange(text: string, range: Range): string | null {
  if (!canApply(text, range)) return null;
  return text.slice(0, range.start) + range.replacement + text.slice(range.end);
}

const NEGATIONS = /\b(not|no|never|none|nobody|nothing|neither|nor|without)\b|n't\b/gi;

function tokens(text: string, pattern: RegExp): string[] {
  return (text.match(pattern) ?? []).map((t) => t.toLowerCase()).sort();
}

function sameTokens(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

// Flags edits that may change what the author meant: different numbers,
// different negation, or different capitalized words (likely names).
export function touchesMeaning(original: string, replacement: string): boolean {
  const numbers = /\d+(?:[.,]\d+)*/g;
  const names = /\b[A-Z][a-zA-Z]+\b/g;
  if (!sameTokens(tokens(original, numbers), tokens(replacement, numbers))) return true;
  // Contractions count as the same negation: "is not" and "isn't" agree.
  if (tokens(original, NEGATIONS).length !== tokens(replacement, NEGATIONS).length) return true;
  const originalNames = (original.match(names) ?? []).filter((w, i) => i > 0 || !isSentenceStart(original, w));
  const replacementNames = (replacement.match(names) ?? []).filter((w, i) => i > 0 || !isSentenceStart(replacement, w));
  return !sameTokens(originalNames.sort(), replacementNames.sort());
}

function isSentenceStart(text: string, word: string): boolean {
  return text.trimStart().startsWith(word);
}
