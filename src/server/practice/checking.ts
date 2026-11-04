import { normalizeText } from "@/lib/text";

export function normalizePracticeAnswer(text: string): string {
  return normalizeText(text)
    .trim()
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}\s']+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function checkPracticeAnswer(input: {
  rung: 1 | 2 | 3 | 4;
  answer: string;
  expected: string;
  options?: string[];
  dontKnow?: boolean;
}): { correct: boolean; normalizedAnswer: string; typoDistance: number } {
  const normalizedAnswer = normalizePracticeAnswer(input.answer);
  const normalizedExpected = normalizePracticeAnswer(input.expected);
  const expectedLength = Array.from(normalizedExpected).length;
  const typoLimit = expectedLength < 10 ? 1 : 2;
  const typoDistance = boundedDamerauLevenshtein(normalizedAnswer, normalizedExpected, typoLimit);
  const nonEmpty = normalizedAnswer.length > 0;

  if (input.rung < 4) {
    const options = (input.options ?? [input.expected]).map(normalizePracticeAnswer);
    const isOption = options.includes(normalizedAnswer);
    return {
      correct: nonEmpty && !input.dontKnow && isOption && normalizedAnswer === normalizedExpected,
      normalizedAnswer,
      typoDistance,
    };
  }

  return {
    correct: nonEmpty && !input.dontKnow && typoDistance <= typoLimit,
    normalizedAnswer,
    typoDistance,
  };
}

function boundedDamerauLevenshtein(left: string, right: string, limit: number): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const overLimit = limit + 1;
  if (Math.abs(a.length - b.length) > limit) return overLimit;
  if (a.length === 0) return Math.min(b.length, overLimit);
  if (b.length === 0) return Math.min(a.length, overLimit);

  let twoRowsBack = Array.from({ length: b.length + 1 }, (_, index) => index);
  let previous = twoRowsBack;
  let current = new Array<number>(b.length + 1).fill(overLimit);

  for (let i = 1; i <= a.length; i++) {
    current.fill(overLimit);
    current[0] = i;
    const first = Math.max(1, i - limit);
    const last = Math.min(b.length, i + limit);
    let rowMinimum = overLimit;

    for (let j = first; j <= last; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = current[j - 1] + 1;
      const deletion = previous[j] + 1;
      let distance = Math.min(substitution, insertion, deletion);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        distance = Math.min(distance, twoRowsBack[j - 2] + 1);
      }
      current[j] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }

    if (rowMinimum > limit) return overLimit;
    twoRowsBack = previous;
    previous = current;
    current = new Array<number>(b.length + 1).fill(overLimit);
  }

  return Math.min(previous[b.length], overLimit);
}
