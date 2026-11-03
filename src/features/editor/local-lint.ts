// Turns raw Harper lints into Suggestions. Kept free of any Harper import so it
// runs on the main thread and in tests; the worker does the actual linting and
// posts plain RawLint objects back.
import { touchesMeaning } from "@/lib/text";
import type { Suggestion, SuggestionCategory } from "@/shared/contracts";

export type RawFix =
  | { type: "replace"; text: string }
  | { type: "remove" }
  // Text that Harper wants added right after the flagged span.
  | { type: "insert_after"; text: string };

export type RawLint = {
  // Name of the rule that produced the lint.
  rule: string;
  kind: string;
  // Span as Harper reports it. Verified against `problem` before use.
  start: number;
  end: number;
  problem: string;
  message: string;
  // First suggested fix, or null when Harper only flags the problem.
  fix: RawFix | null;
  // Replacement texts of every suggestion Harper offered, best first. Lets the
  // mapper skip spelling lints whose candidates look nothing like the word.
  candidates?: string[];
};

// Kinds that are plain mistakes. Everything else Harper reports is polish.
const ERROR_KINDS = new Set([
  "Spelling",
  "Typo",
  "Grammar",
  "Agreement",
  "Capitalization",
  "BoundaryError",
  "Malapropism",
  "Eggcorn",
  "Repetition",
]);

// Rules filed under a generic kind that are still plain mistakes.
const ERROR_RULES = new Set(["AnA"]);

export function categoryFor(lint: Pick<RawLint, "kind" | "rule">): SuggestionCategory {
  return ERROR_KINDS.has(lint.kind) || ERROR_RULES.has(lint.rule) ? "error" : "style";
}

// Maps an index counted in Unicode code points to a UTF-16 index.
function codePointToUtf16(text: string, index: number): number {
  let units = 0;
  let points = 0;
  for (const ch of text) {
    if (points === index) return units;
    units += ch.length;
    points += 1;
  }
  return points === index ? units : -1;
}

// Harper 3.0 reports UTF-16 indices, which is what the editor uses. If a later
// version switches to code points (Rust chars), the fallback converts them. A
// span is accepted only when it points at the text Harper says is the problem.
export function resolveSpan(text: string, lint: Pick<RawLint, "start" | "end" | "problem">): { start: number; end: number } | null {
  const { start, end, problem } = lint;
  if (end > start && text.slice(start, end) === problem) return { start, end };
  const s = codePointToUtf16(text, start);
  const e = codePointToUtf16(text, end);
  if (s >= 0 && e > s && text.slice(s, e) === problem) return { start: s, end: e };
  return null;
}

function hash36(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Harper wraps words in backticks; the UI shows them as quotes.
function tidyMessage(message: string): string {
  return message.replace(/`([^`]*)`/g, "“$1”").replace(/\s+/g, " ").trim().slice(0, 200);
}

// Punctuation that separates clauses. When it sits between two letters with no
// space ("Enor,ous", "yesterday,and") the surrounding words are not a spelling
// problem; the missing space is. A full stop is left out on purpose: it is also
// part of "e.g.", "a.m." and file names.
const GLUE = new Set([",", ";", ":", "!", "?"]);
const LETTER = /\p{L}/u;
const WORD_CHAR = /[\p{L}\p{N}_'’]/u;

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && LETTER.test(ch);
}

// True when a punctuation mark touches the span with a letter on its far side.
export function gluedToPunctuation(text: string, start: number, end: number): boolean {
  const left = GLUE.has(text[start - 1] ?? "") && isLetter(text[start - 2]);
  const right = GLUE.has(text[end] ?? "") && isLetter(text[end + 1]);
  return left || right;
}

// Optimal string alignment distance: insert, delete, substitute, and swap two
// neighbours, each costing one.
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[rows - 1][cols - 1];
}

// A spelling fix is only worth showing when it looks like the word the learner
// meant: at most 2 edits for words up to 6 letters, 3 up to 10, 4 beyond.
export function looksLikeFix(word: string, candidate: string): boolean {
  const from = word.toLowerCase();
  const limit = from.length <= 6 ? 2 : from.length <= 10 ? 3 : 4;
  return editDistance(from, candidate.toLowerCase()) <= limit;
}

type Candidate = { start: number; end: number; original: string; replacement: string };

// The first spelling candidate that resembles the word, or null when none does.
function pickSpelling(lint: RawLint, original: string): string | null {
  const offered = lint.candidates?.length ? lint.candidates : lint.fix?.type === "replace" ? [lint.fix.text] : [];
  if (offered.length === 0) return lint.fix?.type === "replace" ? lint.fix.text : null;
  return offered.find((candidate) => looksLikeFix(original, candidate)) ?? null;
}

// A missing space after a comma between two words is reported on the comma
// alone. Showing the whole glued span ("Enor,ous" -> "Enor, ous") makes the
// card and the highlight say what is wrong.
function widenGluedSpacing(text: string, c: Candidate): Candidate {
  const tail = c.replacement.slice(1);
  const spacingFix =
    c.original.length === 1 &&
    GLUE.has(c.original) &&
    c.replacement.startsWith(c.original) &&
    tail.length > 0 &&
    tail.trim() === "" &&
    isLetter(text[c.start - 1]) &&
    isLetter(text[c.end]);
  if (!spacingFix) return c;
  let start = c.start;
  let end = c.end;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHAR.test(text[end])) end++;
  return {
    start,
    end,
    original: text.slice(start, end),
    replacement: text.slice(start, c.start) + c.replacement + text.slice(c.end, end),
  };
}

export function mapLints(text: string, lints: RawLint[]): Suggestion[] {
  const result: Suggestion[] = [];
  for (const lint of lints) {
    if (!lint.fix) continue;
    const span = resolveSpan(text, lint);
    if (!span) continue;
    const original = text.slice(span.start, span.end);
    let replacement =
      lint.fix.type === "replace" ? lint.fix.text : lint.fix.type === "remove" ? "" : original + lint.fix.text;
    if (lint.kind === "Spelling") {
      // Harper guesses wildly at words glued to punctuation or at unknown
      // strings; a wrong-looking card teaches nothing.
      if (gluedToPunctuation(text, span.start, span.end)) continue;
      const picked = pickSpelling(lint, original);
      if (picked === null) continue;
      replacement = picked;
    }
    if (replacement === original) continue;
    const c = widenGluedSpacing(text, { ...span, original, replacement });
    result.push({
      id: `local-${c.start}-${c.end}-${hash36(`${lint.rule}|${c.replacement}`)}`,
      source: "local",
      category: categoryFor(lint),
      start: c.start,
      end: c.end,
      original: c.original,
      replacement: c.replacement,
      reason: tidyMessage(lint.message),
      meaningChange: touchesMeaning(c.original, c.replacement),
      meaning: null,
    });
  }
  return result.sort((a, b) => a.start - b.start || a.end - b.end);
}
