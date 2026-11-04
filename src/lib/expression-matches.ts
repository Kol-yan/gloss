import type { Expression } from "@/shared/contracts";

export type ExpressionMatch = { expression: Expression; start: number; end: number };

// Deliberately bounded English morphology, shared by the browser and server.
// Whole tokens prevent substrings ("table" in "stable") becoming evidence.
const IRREGULAR = [
  ["take", "takes", "taking", "took", "taken"],
  ["get", "gets", "getting", "got", "gotten"],
  ["go", "goes", "going", "went", "gone"],
  ["make", "makes", "making", "made"],
  ["bring", "brings", "bringing", "brought"],
  ["put", "puts", "putting"],
  ["run", "runs", "running", "ran"],
  ["come", "comes", "coming", "came"],
  ["set", "sets", "setting"],
  ["keep", "keeps", "keeping", "kept"],
  ["break", "breaks", "breaking", "broke", "broken"],
  ["hold", "holds", "holding", "held"],
  ["leave", "leaves", "leaving", "left"],
  ["give", "gives", "giving", "gave", "given"],
] as const;
const FIXED = new Set(["a", "an", "the", "to", "of", "off", "on", "in", "at", "by", "for", "with", "as", "and", "or", "is", "was", "has", "this", "it"]);

function tokens(text: string) {
  return [...text.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}]+)*/gu)];
}

function forms(word: string): Set<string> {
  word = word.toLowerCase().replace(/’/g, "'");
  const irregular = IRREGULAR.find((group) => (group as readonly string[]).includes(word));
  if (irregular) return new Set(irregular);
  const result = new Set([word]);
  if (FIXED.has(word) || word.length < 3) return result;
  // Expressions are stored in their display form; compare variants in either
  // direction so a saved plural also recognizes its singular.
  if (/ies$/.test(word)) result.add(word.slice(0, -3) + "y");
  if (/s$/.test(word) && !/(ss|us|is)$/.test(word)) result.add(word.slice(0, -1));
  if (/(ches|shes|xes|zes|oes)$/.test(word)) result.add(word.slice(0, -2));
  if (/ied$/.test(word)) result.add(word.slice(0, -3) + "y");
  if (/ed$/.test(word)) {
    const stem = word.slice(0, -2);
    result.add(stem);
    if (/(.)\1$/.test(stem)) result.add(stem.slice(0, -1));
    result.add(word.slice(0, -1));
  }
  if (/ing$/.test(word)) {
    const stem = word.slice(0, -3);
    result.add(stem);
    result.add(stem + "e");
    if (/(.)\1$/.test(stem)) result.add(stem.slice(0, -1));
  }
  const stem = word;
  result.add(stem + "s");
  if (/(ch|sh|x|z|o)$/.test(stem)) result.add(stem + "es");
  if (/[^aeiou]y$/.test(stem)) {
    result.add(stem.slice(0, -1) + "ies");
    result.add(stem.slice(0, -1) + "ied");
  }
  result.add(stem.endsWith("e") ? stem + "d" : stem + "ed");
  result.add(stem.endsWith("e") ? stem.slice(0, -1) + "ing" : stem + "ing");
  return result;
}

export function matchExpressions(text: string, expressions: Expression[]): ExpressionMatch[] {
  const words = tokens(text);
  const found: ExpressionMatch[] = [];
  for (const expression of expressions) {
    const targetWords = tokens(expression.text);
    const target = targetWords.map((token) => forms(token[0]));
    if (!target.length) continue;
    for (let i = 0; i <= words.length - target.length; i++) {
      if (!target.every((variants, j) => {
        const current = forms(words[i + j][0]);
        return [...variants].some((form) => current.has(form));
      })) continue;
      const first = words[i];
      const last = words[i + target.length - 1];
      // Inflection is allowed; skipping words or sentence punctuation is not.
      if (words.slice(i, i + target.length - 1).some((word, j) => {
        const gap = text.slice(word.index + word[0].length, words[i + j + 1].index);
        const expected = expression.text.slice(targetWords[j].index + targetWords[j][0].length, targetWords[j + 1].index);
        return /^\s+$/.test(expected) ? !/^\s+$/.test(gap) : expected !== gap;
      })) continue;
      found.push({ expression, start: first.index, end: last.index + last[0].length });
    }
  }
  return found.sort((a, b) => a.start - b.start || a.end - b.end);
}

export type WritingRange = { start: number; end: number };
export function unassistedMatches(text: string, expressions: Expression[], assisted: WritingRange[]) {
  return matchExpressions(text, expressions).filter((match) =>
    !assisted.some((range) => match.start < range.end && range.start < match.end));
}

// Assisted spans survive edits and Undo. Retyping part of a supplied phrase
// cannot silently turn accepted help into independent production.
export function moveAssistedRanges(before: string, after: string, ranges: WritingRange[]): WritingRange[] {
  if (before === after) return ranges;
  let start = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < Math.min(before.length, after.length) - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const oldEnd = before.length - tail;
  const newEnd = after.length - tail;
  const delta = newEnd - oldEnd;
  return ranges.map((range) => {
    if (range.end < start) return range;
    if (range.start > oldEnd) return { start: range.start + delta, end: range.end + delta };
    return { start: Math.min(range.start, start), end: Math.max(newEnd, range.end + delta) };
  }).filter((range) => range.end > range.start);
}
