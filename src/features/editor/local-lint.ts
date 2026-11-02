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

export function mapLints(text: string, lints: RawLint[]): Suggestion[] {
  const result: Suggestion[] = [];
  for (const lint of lints) {
    if (!lint.fix) continue;
    const span = resolveSpan(text, lint);
    if (!span) continue;
    const original = text.slice(span.start, span.end);
    const replacement =
      lint.fix.type === "replace" ? lint.fix.text : lint.fix.type === "remove" ? "" : original + lint.fix.text;
    if (replacement === original) continue;
    result.push({
      id: `local-${span.start}-${span.end}-${hash36(`${lint.rule}|${replacement}`)}`,
      source: "local",
      category: categoryFor(lint),
      start: span.start,
      end: span.end,
      original,
      replacement,
      reason: tidyMessage(lint.message),
      meaningChange: touchesMeaning(original, replacement),
      meaning: null,
    });
  }
  return result.sort((a, b) => a.start - b.start || a.end - b.end);
}
