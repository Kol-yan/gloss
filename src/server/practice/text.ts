// Text matching helpers for practice. "Normalized" means lowercase letters and
// digits separated by single spaces, so punctuation, case and spacing do not
// hide an expression.
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// True when `phrase` occurs in `text` as whole words.
export function containsPhrase(text: string, phrase: string): boolean {
  const needle = normalizeForMatch(phrase);
  if (!needle) return false;
  return ` ${normalizeForMatch(text)} `.includes(` ${needle} `);
}

function words(text: string): string[] {
  const normalized = normalizeForMatch(text);
  return normalized ? normalized.split(" ") : [];
}

// Word-level Levenshtein distance between two texts.
export function wordEditDistance(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++) {
      const substitution = previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j] + 1, current[j - 1] + 1);
    }
    previous = current;
  }
  return previous[y.length];
}

export const TRANSCRIPT_EDIT_THRESHOLD = 0.2;

// Did the learner change what the speech recognizer heard in a way that matters?
// Yes when more than 20% of the raw words were edited, or when the target
// expression is in the confirmed text but was not heard.
export function isTranscriptEdited(raw: string, confirmed: string, target: string): boolean {
  if (containsPhrase(confirmed, target) && !containsPhrase(raw, target)) return true;
  const rawWords = words(raw).length;
  const distance = wordEditDistance(raw, confirmed);
  if (distance === 0) return false;
  if (rawWords === 0) return true;
  return distance / rawWords > TRANSCRIPT_EDIT_THRESHOLD;
}
