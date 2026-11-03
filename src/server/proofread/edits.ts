import { locateFragment, normalizeText, touchesMeaning, type Sentence } from "@/lib/text";
import { sanitizeIpa } from "@/lib/pronunciation";
import type { Suggestion } from "@/shared/contracts";
import { newId } from "../ids";
import { diffHunks, tokenize, type Hunk } from "./diff";
import {
  MAX_ERROR_SUGGESTIONS,
  MAX_EXPRESSION_EDITS,
  MAX_MEANING_LENGTH,
  MAX_REASON_LENGTH,
  type ProofreadOutput,
  type RawChange,
  type RawCorrection,
  type RawImprovement,
} from "./schema";

// A correction is not a rewrite. A corrected sentence that is much longer than
// the original, or that replaces most of a sentence of some length, is ignored:
// it is more likely a misnumbered or invented sentence than a set of fixes.
const MAX_GROWTH_FACTOR = 3;
const MAX_GROWTH_EXTRA = 100;
const MIN_REWRITE_LENGTH = 25;
const MAX_CHANGED_SHARE = 0.6;

const FALLBACK_REASON = "Fixes a grammar, spelling or punctuation mistake.";

export type ProofreadMode = "check" | "verify";

// Turns the model's answer into suggestions. All positions come from the
// server's own sentence split and word-level diff, never from the model.
// - Errors: the model returns each faulty sentence corrected as a whole; every
//   difference from the original is one "error" suggestion. Applying all of a
//   sentence's suggestions, in any order, gives exactly the corrected sentence.
// - Improvements (style and expressions) are optional fragments located in the
//   original sentence. They are dropped when they overlap an error fix.
// - In "verify" mode only errors are reported: a sentence that comes back
//   unchanged has no suggestions, and optional improvements are not wanted.
export function resolveProofread(
  sentences: Sentence[],
  output: ProofreadOutput,
  mode: ProofreadMode = "check",
): Suggestion[] {
  const errors = resolveCorrections(sentences, output.corrections);
  const improvements = mode === "verify" ? [] : resolveEdits(sentences, output.improvements, errors);
  return [...errors, ...improvements].sort((a, b) => a.start - b.start);
}

export function resolveCorrections(sentences: Sentence[], corrections: RawCorrection[]): Suggestion[] {
  const kept: Suggestion[] = [];
  const seen = new Set<number>();

  for (const correction of corrections) {
    const sentence = sentences[correction.sentence_index];
    // The first answer for a sentence wins.
    if (!sentence || seen.has(correction.sentence_index)) continue;
    seen.add(correction.sentence_index);

    const corrected = unframe(dropNumber(normalizeText(correction.corrected).trim(), sentence.text), sentence.text);
    if (!corrected || corrected === sentence.text) continue;
    if (corrected.length > sentence.text.length * MAX_GROWTH_FACTOR + MAX_GROWTH_EXTRA) continue;

    const hunks = diffHunks(sentence.text, corrected);
    // All of a sentence's fixes or none: a partial fix is not a correction.
    if (hunks.length === 0 || kept.length + hunks.length > MAX_ERROR_SUGGESTIONS) continue;
    if (isRewrite(sentence.text, corrected, hunks)) continue;

    const used = new Set<RawChange>();
    for (const hunk of hunks) {
      const note = bestNote(hunk, correction.changes, used);
      if (note) used.add(note);
      kept.push({
        id: newId(),
        source: "ai",
        category: "error",
        start: sentence.start + hunk.start,
        end: sentence.start + hunk.end,
        original: hunk.original,
        replacement: hunk.replacement,
        reason: tidy(note?.reason ?? "", MAX_REASON_LENGTH) || FALLBACK_REASON,
        meaningChange: changesMeaning(hunk.original, hunk.replacement, hunk.start === 0),
        meaning: null,
        ipa: null,
      });
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

function isRewrite(original: string, corrected: string, hunks: Hunk[]): boolean {
  if (original.length < MIN_REWRITE_LENGTH) return false;
  const removed = hunks.reduce((total, hunk) => total + hunk.original.length, 0);
  const added = hunks.reduce((total, hunk) => total + hunk.replacement.length, 0);
  return removed / original.length > MAX_CHANGED_SHARE || added / corrected.length > MAX_CHANGED_SHARE;
}

// The prompt numbers each sentence as "[2] ...". A model sometimes copies that
// number into the corrected sentence; it is not part of the learner's text.
function dropNumber(corrected: string, original: string): string {
  return /^\[\d+\]/.test(original) ? corrected : corrected.replace(/^\[\d+\]\s*/, "");
}

// The prompt breaks a closing "</text" tag inside the learner's text (see
// frameForPrompt). A sentence that really contains that sequence gets it back,
// so copying it is not mistaken for an edit.
function unframe(corrected: string, original: string): string {
  return /<\/text/i.test(original) ? corrected.replace(/<\/ (text)/gi, "</$1") : corrected;
}

// Picks the model's note that best explains a difference: the one sharing the
// most words with it. Ties and no overlap prefer notes not used yet, in the
// model's order. Null when the model gave no usable note.
function bestNote(hunk: Hunk, changes: RawChange[], used: Set<RawChange>): RawChange | null {
  const words = new Set(wordsOf(hunk.original + " " + hunk.replacement));
  let best: RawChange | null = null;
  let bestScore = -1;
  for (const change of changes) {
    if (!change.reason.trim()) continue;
    const shared = new Set(wordsOf(change.original + " " + change.replacement).filter((w) => words.has(w)));
    const score = shared.size * 2 + (used.has(change) ? 0 : 1);
    if (score > bestScore) {
      best = change;
      bestScore = score;
    }
  }
  return best;
}

function wordsOf(text: string): string[] {
  return tokenize(text.toLowerCase()).filter((t) => /^[\p{L}\p{N}]/u.test(t));
}

// Resolves optional style and expression edits. `taken` are suggestions that
// already hold their ranges; an edit overlapping one of them is dropped.
// Dropped: unknown sentence, empty or missing original, no-op, fragment not
// found or ambiguous, empty reason, edits that change protected facts, names,
// pronouns or time boundaries, edits that remove more substantive words than
// they add, overlaps (the first one wins), and "expression" edits beyond the third.
// `meaning` is kept only for "expression" edits and is null when the model
// gave none; such a suggestion is still shown but cannot become practice.
export function resolveEdits(
  sentences: Sentence[],
  edits: RawImprovement[],
  taken: Pick<Suggestion, "start" | "end">[] = [],
): Suggestion[] {
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
    const startsSentence = range.start === sentence.start;
    if (changesCommitments(edit.original, edit.replacement, startsSentence)) continue;
    if (removesContentWords(edit.original, edit.replacement)) continue;
    if ([...taken, ...kept].some((other) => range.start < other.end && other.start < range.end)) continue;
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
      meaningChange: changesMeaning(edit.original, edit.replacement, startsSentence),
      meaning: edit.category === "expression" ? tidy(edit.meaning, MAX_MEANING_LENGTH) || null : null,
      ipa: edit.category === "expression" ? sanitizeIpa(edit.ipa, edit.replacement) : null,
    });
  }

  return kept.sort((a, b) => a.start - b.start);
}

// An optional edit must preserve protected facts and boundaries. The prompt
// asks for that, but a model may still alter negation, a number, a name, a
// pronoun or a deadline, so such an edit is dropped here rather than shown
// with a warning. Corrections never go through this check.
const NEGATION_WORDS =
  /\b(?:not|no|never|none|nobody|nothing|nowhere|neither|nor|without|cannot)\b|n't\b/gi;
const NUMBER_WORDS =
  /\d+(?:[.,:]\d+)*|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion|half|dozen)\b/gi;
// Obligation, possibility, frequency and quantity.
const COMMITMENT_WORDS =
  /\b(?:must|should|shall|need|needs|will|would|can|could|may|might|always|usually|often|sometimes|rarely|seldom|ever|only|all|every|each|most|many|few|almost|nearly|least)\b/gi;
const NEUTRAL_PRONOUNS = /\b(?:they|them|their|theirs|themself|themselves)\b/gi;
const TIME_BOUNDARY_PREPOSITIONS = /\b(?:before|by|after|until|till|within|since|during)\b/gi;
const CAPITALIZED_WORDS = /(?<![\p{L}\p{M}'’])\p{Lu}[\p{L}\p{M}'’-]*/gu;
const LEXICAL_WORDS = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;
const NEGATIVE_CONTRACTION_BASES = new Map<string, string>([
  ["can't", "can"],
  ["won't", "will"],
  ["shan't", "shall"],
]);
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "nor", "so", "yet", "if", "than", "that", "though", "while",
  "as", "at", "from", "in", "into", "of", "on", "onto", "to", "with",
]);

function changesCommitments(original: string, replacement: string, atSentenceStart: boolean): boolean {
  return (
    !sameWords(matches(original, NEGATION_WORDS).map(negation), matches(replacement, NEGATION_WORDS).map(negation)) ||
    !sameWords(matches(original, NUMBER_WORDS), matches(replacement, NUMBER_WORDS)) ||
    !sameWords(matches(original, COMMITMENT_WORDS), matches(replacement, COMMITMENT_WORDS)) ||
    !sameWords(matches(original, NEUTRAL_PRONOUNS), matches(replacement, NEUTRAL_PRONOUNS)) ||
    !sameWords(matches(original, TIME_BOUNDARY_PREPOSITIONS), matches(replacement, TIME_BOUNDARY_PREPOSITIONS)) ||
    !sameWords(names(original, atSentenceStart), names(replacement, atSentenceStart))
  );
}

// Optional edits may replace a content word with a synonym, but must not
// discard more substantive words than they add. Compare the supplied fragments
// directly: diffHunks expands deletions with neighboring context.
function removesContentWords(original: string, replacement: string): boolean {
  const removed = wordCounts(original);
  const added = wordCounts(replacement);
  let removedCount = 0;
  let addedCount = 0;

  for (const word of new Set([...removed.keys(), ...added.keys()])) {
    const difference = (removed.get(word) ?? 0) - (added.get(word) ?? 0);
    if (difference > 0) removedCount += difference;
    else addedCount -= difference;
  }

  return removedCount > addedCount;
}

function wordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(LEXICAL_WORDS)) {
    const word = match[0].toLowerCase().replace(/’/g, "'");
    const negativeBase = NEGATIVE_CONTRACTION_BASES.get(word);
    const expanded = negativeBase ? [negativeBase, "not"] : word.endsWith("n't") ? [word.slice(0, -3), "not"] : [word];
    for (const token of expanded) {
      if (FUNCTION_WORDS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

function matches(text: string, pattern: RegExp): string[] {
  return (text.match(pattern) ?? []).map((word) => word.toLowerCase());
}

// "isn't" and "is not" say the same; "never" and "not" do not.
function negation(word: string): string {
  return word === "n't" || word === "cannot" ? "not" : word;
}

// Capitalized words other than the pronoun "I" are likely names. The first
// word of a sentence is capitalized anyway, so it does not count.
function names(text: string, atSentenceStart: boolean): string[] {
  const leading = text.length - text.trimStart().length;
  return [...text.matchAll(CAPITALIZED_WORDS)]
    .filter((match) => !(atSentenceStart && match.index === leading))
    .map((match) => match[0].replace(/’/g, "'"))
    .filter((word) => !/^I(?:'[a-z]+)?$/.test(word));
}

function sameWords(a: string[], b: string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((word, i) => word === right[i]);
}

// touchesMeaning ignores a capitalized first word, assuming it starts a
// sentence. A fragment from the middle of a sentence gets a lowercase prefix so
// a name at its start (an edit of just "Anna") is still recognised as a name.
function changesMeaning(original: string, replacement: string, atSentenceStart: boolean): boolean {
  const prefix = atSentenceStart ? "" : "x ";
  return touchesMeaning(prefix + original, prefix + replacement);
}

function tidy(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  // Cut at a word boundary and mark the cut.
  const cut = text.slice(0, maxLength - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > maxLength / 3 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
