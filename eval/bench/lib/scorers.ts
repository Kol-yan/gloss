// Pure scoring functions for the model benchmark. They take the dataset item
// and what the app made of the model's answer, and return numbers only, so
// they can be unit-tested without any model call.
import type { Verdict } from "@/shared/contracts";

// ---------------------------------------------------------------------------
// Proofreading
// ---------------------------------------------------------------------------

export interface ExpectedError {
  // A substring of the text that occurs exactly once and contains the mistake.
  span: string;
  // Accepted replacements for the whole span.
  fixes: string[];
  topic?: string;
}

export interface PredictedEdit {
  start: number;
  end: number;
  replacement: string;
}

export interface ProofreadScore {
  expected: number;
  predicted: number;
  // Expected errors whose span was touched by at least one predicted edit.
  located: number;
  // Expected errors fixed to one of the accepted fixes, character for character.
  fixedExact: number;
  // Same, ignoring case, quote style, commas and spacing.
  fixedNear: number;
  // Predicted edits that belong to an exactly or nearly correct fix.
  predictedExact: number;
  predictedNear: number;
  // Predicted edits that touch no expected error at all.
  falsePositives: number;
  // Every expected error nearly fixed and nothing else changed.
  itemCorrect: boolean;
}

// The cartesian product of accepted fixes is bounded so a pathological item
// cannot blow up; real items have one to three errors per cluster.
const MAX_WINDOW_VARIANTS = 256;

export function nearForm(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑–—]/g, "-")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function uniqueRange(text: string, span: string): { start: number; end: number } | null {
  if (!span) return null;
  const start = text.indexOf(span);
  if (start < 0 || text.indexOf(span, start + 1) >= 0) return null;
  return { start, end: start + span.length };
}

function applyEdits(text: string, offset: number, edits: PredictedEdit[]): string {
  let out = "";
  let cursor = offset;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return out;
}

// Expected errors and predicted edits are grouped into clusters of
// overlapping ranges. A model that fixes two neighbouring mistakes in one
// edit, or one mistake in two edits, is still judged on the resulting words:
// the cluster window must read like one of the accepted fixes.
export function scoreProofread(text: string, errors: ExpectedError[], predicted: PredictedEdit[]): ProofreadScore {
  type Node =
    | { kind: "expected"; start: number; end: number; error: ExpectedError }
    | { kind: "predicted"; start: number; end: number; edit: PredictedEdit };
  const nodes: Node[] = [];
  for (const error of errors) {
    const range = uniqueRange(text, error.span);
    if (!range) throw new Error(`span is not unique in text: ${error.span}`);
    nodes.push({ kind: "expected", ...range, error });
  }
  for (const edit of predicted) {
    if (edit.start < 0 || edit.end > text.length || edit.end < edit.start) continue;
    nodes.push({ kind: "predicted", start: edit.start, end: edit.end, edit });
  }
  nodes.sort((a, b) => a.start - b.start || a.end - b.end);

  const clusters: Node[][] = [];
  let reach = -1;
  for (const node of nodes) {
    const last = clusters[clusters.length - 1];
    // Zero-length predicted edits (pure insertions) join a cluster they touch.
    // Expected errors separated only by spaces are one cluster too: a word
    // moved across their border ("explained us the process in details") can
    // be split between them in many equally valid ways.
    const touchingExpected = node.kind === "expected" && last?.some((other) => other.kind === "expected") &&
      /^\s*$/.test(text.slice(reach, node.start));
    const joins = last && (node.start < reach || (node.start === reach && node.start === node.end) || touchingExpected);
    if (joins) {
      last.push(node);
      reach = Math.max(reach, node.end);
    } else {
      clusters.push([node]);
      reach = node.end;
    }
  }

  const score: ProofreadScore = {
    expected: errors.length,
    predicted: nodes.filter((node) => node.kind === "predicted").length,
    located: 0,
    fixedExact: 0,
    fixedNear: 0,
    predictedExact: 0,
    predictedNear: 0,
    falsePositives: 0,
    itemCorrect: false,
  };

  for (const cluster of clusters) {
    const expected = cluster.filter((node) => node.kind === "expected");
    const edits = cluster.flatMap((node) => (node.kind === "predicted" ? [node.edit] : []));
    if (expected.length === 0) {
      score.falsePositives += edits.length;
      continue;
    }
    if (edits.length === 0) continue;
    score.located += expected.length;

    const windowStart = Math.min(...cluster.map((node) => node.start));
    const windowEnd = Math.max(...cluster.map((node) => node.end));
    const got = applyEdits(text, windowStart, edits) + text.slice(Math.max(windowStart, ...edits.map((e) => e.end)), windowEnd);
    const variants = expectedWindows(text, windowStart, windowEnd, expected.map((node) => ({ ...node })));
    const exact = variants.includes(got);
    const near = exact || variants.some((variant) => nearForm(variant) === nearForm(got));
    if (exact) {
      score.fixedExact += expected.length;
      score.predictedExact += edits.length;
    }
    if (near) {
      score.fixedNear += expected.length;
      score.predictedNear += edits.length;
    }
  }

  score.itemCorrect = score.fixedNear === score.expected && score.predictedNear === score.predicted;
  return score;
}

function expectedWindows(
  text: string,
  windowStart: number,
  windowEnd: number,
  expected: { start: number; end: number; error: ExpectedError }[],
): string[] {
  let variants = [""];
  let cursor = windowStart;
  for (const node of expected.sort((a, b) => a.start - b.start)) {
    const between = text.slice(cursor, node.start);
    const next: string[] = [];
    for (const prefix of variants) {
      for (const fix of node.error.fixes) {
        if (next.length < MAX_WINDOW_VARIANTS) next.push(prefix + between + fix);
      }
    }
    variants = next;
    cursor = node.end;
  }
  const tail = text.slice(cursor, windowEnd);
  return variants.map((variant) => variant + tail);
}

export interface ProofreadTotals {
  items: number;
  expected: number;
  predicted: number;
  located: number;
  fixedExact: number;
  fixedNear: number;
  precisionExact: number | null;
  recallExact: number | null;
  precisionNear: number | null;
  recallNear: number | null;
  f1Near: number | null;
  falsePositives: number;
  cleanItems: number;
  // Clean texts that got at least one error edit: the main "annoyance" number.
  cleanFlagged: number;
  itemsCorrect: number;
}

export function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

export function f1(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null) return null;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export function totalProofread(scores: ProofreadScore[]): ProofreadTotals {
  const sum = (key: keyof Omit<ProofreadScore, "itemCorrect">) => scores.reduce((n, s) => n + s[key], 0);
  const expected = sum("expected");
  const predicted = sum("predicted");
  const precisionNear = ratio(sum("predictedNear"), predicted);
  const recallNear = ratio(sum("fixedNear"), expected);
  const clean = scores.filter((s) => s.expected === 0);
  return {
    items: scores.length,
    expected,
    predicted,
    located: sum("located"),
    fixedExact: sum("fixedExact"),
    fixedNear: sum("fixedNear"),
    precisionExact: ratio(sum("predictedExact"), predicted),
    recallExact: ratio(sum("fixedExact"), expected),
    precisionNear,
    recallNear,
    f1Near: f1(precisionNear, recallNear),
    falsePositives: sum("falsePositives"),
    cleanItems: clean.length,
    cleanFlagged: clean.filter((s) => s.predicted > 0).length,
    itemsCorrect: scores.filter((s) => s.itemCorrect).length,
  };
}

// ---------------------------------------------------------------------------
// Dictation clean-up
// ---------------------------------------------------------------------------

export function words(text: string): string[] {
  return text.toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];
}

function counts(list: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of list) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
}

// True when the words of `term` appear consecutively in `text`, ignoring case
// and punctuation: "mañana mañana" is found in "mañana, mañana", and "no" is
// not found in "cannot".
export function containsWords(text: string, term: string): boolean {
  const haystack = words(text);
  const needle = words(term);
  if (needle.length === 0) return true;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

// Levenshtein distance over code points, two rows of memory.
export function editDistance(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

const squash = (text: string) => text.normalize("NFC").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();

// 0 means identical, 1 means nothing in common.
export function normalizedEditDistance(output: string, expected: string): number {
  const a = squash(output);
  const b = squash(expected);
  const longest = Math.max(Array.from(a).length, Array.from(b).length);
  return longest === 0 ? 0 : editDistance(a, b) / longest;
}

export interface DictationScore {
  // Best (lowest) normalized edit distance to the expected text or an accepted variant.
  distance: number;
  // Output words that were never spoken. The app rejects such an output.
  addedWords: string[];
  // Share of the expected words (multiset) that the output kept.
  keptShare: number;
  // Terms the item marks as must-keep (names, numbers, non-English words) that are missing.
  missingKeep: string[];
  // No word added, every expected word and must-keep term still there.
  wordsPreserved: boolean;
  exact: boolean;
}

export function scoreDictation(input: {
  transcript: string;
  expected: string;
  accept?: string[];
  keep?: string[];
  output: string;
}): DictationScore {
  const references = [input.expected, ...(input.accept ?? [])];
  const distance = Math.min(...references.map((reference) => normalizedEditDistance(input.output, reference)));
  const exact = references.some((reference) => squash(reference) === squash(input.output));

  const spoken = counts(words(input.transcript));
  const addedWords: string[] = [];
  for (const word of words(input.output)) {
    const left = spoken.get(word) ?? 0;
    if (left === 0) addedWords.push(word);
    else spoken.set(word, left - 1);
  }

  const produced = counts(words(input.output));
  const expectedWords = words(input.expected);
  let kept = 0;
  for (const word of expectedWords) {
    const left = produced.get(word) ?? 0;
    if (left > 0) {
      kept++;
      produced.set(word, left - 1);
    }
  }
  const keptShare = expectedWords.length === 0 ? 1 : kept / expectedWords.length;
  const missingKeep = (input.keep ?? []).filter((term) => !containsWords(input.output, term));
  return {
    distance,
    addedWords,
    keptShare,
    missingKeep,
    wordsPreserved: addedWords.length === 0 && keptShare === 1 && missingKeep.length === 0,
    exact,
  };
}

// ---------------------------------------------------------------------------
// Practice answer evaluation
// ---------------------------------------------------------------------------

export type JudgedVerdict = Exclude<Verdict, "unavailable">;
export const VERDICTS: JudgedVerdict[] = ["used_well", "almost", "not_yet"];

export interface EvaluationScore {
  verdict: JudgedVerdict | null;
  // The verdict is one of the item's acceptable verdicts.
  acceptable: boolean;
  // The verdict equals the single expected verdict.
  strict: boolean;
  // "used_well" given where it is not acceptable: a wrong answer passed.
  falsePass: boolean;
}

export function scoreEvaluation(
  item: { expected: JudgedVerdict; acceptable: JudgedVerdict[] },
  verdict: JudgedVerdict | null,
): EvaluationScore {
  if (verdict === null) return { verdict, acceptable: false, strict: false, falsePass: false };
  return {
    verdict,
    acceptable: item.acceptable.includes(verdict),
    strict: verdict === item.expected,
    falsePass: verdict === "used_well" && !item.acceptable.includes("used_well"),
  };
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

// Nearest-rank percentile, the same definition the older eval reports use.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}
