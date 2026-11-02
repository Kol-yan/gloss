import { locateFragment, touchesMeaning, type Sentence } from "@/lib/text";
import type { Suggestion } from "@/shared/contracts";
import { newId } from "../ids";
import {
  MAX_EXPRESSION_EDITS,
  MAX_MEANING_LENGTH,
  MAX_REASON_LENGTH,
  type RawEdit,
} from "./schema";

// Turns the model's proposals into suggestions. All positions come from the
// server's own sentence split and exact matching, never from the model.
// Dropped: unknown sentence, empty or missing original, no-op, fragment not
// found or ambiguous, empty reason, and edits overlapping an earlier kept
// edit (the first one wins), and "expression" edits beyond the second.
// `meaning` is kept only for "expression" edits and is null when the model
// gave none; such a suggestion is still shown but cannot become practice.
export function resolveEdits(sentences: Sentence[], edits: RawEdit[]): Suggestion[] {
  const kept: Suggestion[] = [];
  let expressionCount = 0;

  for (const edit of edits) {
    const sentence = sentences[edit.sentence_index];
    if (!sentence) continue;
    if (!edit.original || edit.replacement === edit.original) continue;
    const reason = tidy(edit.reason, MAX_REASON_LENGTH);
    if (!reason) continue;

    const range = locateFragment(sentence, edit.original);
    if (!range) continue;
    if (kept.some((other) => range.start < other.end && other.start < range.end)) continue;
    if (edit.category === "expression" && expressionCount >= MAX_EXPRESSION_EDITS) continue;
    if (edit.category === "expression") expressionCount++;

    kept.push({
      id: newId(),
      source: "ai",
      category: edit.category,
      start: range.start,
      end: range.end,
      original: edit.original,
      replacement: edit.replacement,
      reason,
      meaningChange: changesMeaning(edit, range.start === sentence.start),
      meaning: edit.category === "expression" ? tidy(edit.meaning, MAX_MEANING_LENGTH) || null : null,
    });
  }

  return kept.sort((a, b) => a.start - b.start);
}

// touchesMeaning ignores a capitalized first word, assuming it starts a
// sentence. A fragment from the middle of a sentence gets a lowercase prefix so
// a name at its start (an edit of just "Anna") is still recognised as a name.
function changesMeaning(edit: RawEdit, atSentenceStart: boolean): boolean {
  const prefix = atSentenceStart ? "" : "x ";
  return touchesMeaning(prefix + edit.original, prefix + edit.replacement);
}

function tidy(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  // Cut at a word boundary and mark the cut.
  const cut = text.slice(0, maxLength - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > maxLength / 3 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
