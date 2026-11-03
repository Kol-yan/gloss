// Word-level difference between a sentence and its corrected version. The model
// supplies the corrected sentence; this deterministic code finds what changed.
// Hunks are non-overlapping ranges of the original, so applying every hunk, in
// any order, gives exactly the corrected sentence.

export interface Hunk {
  // UTF-16 offsets into the original string.
  start: number;
  end: number;
  original: string;
  replacement: string;
}

// Words (with inner apostrophes and hyphens), numbers with separators,
// whitespace runs, and any other single character. The pieces always join back
// into the input.
const TOKEN = /\p{N}+(?:[.,]\p{N}+)+|[\p{L}\p{M}\p{N}]+(?:['’‐‑-][\p{L}\p{M}\p{N}]+)*|\s+|[\s\S]/gu;

// Bounds the table of the longest-common-subsequence search. A longer middle
// part (two very long, very different run-on sentences) becomes one hunk.
const MAX_TABLE_CELLS = 2_000_000;

// Hunks separated by at most this many non-whitespace tokens are one suggestion:
// "doesn't ... like" or "a ... an" depend on each other.
const MAX_MERGE_GAP = 1;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

type Segment = { kind: "same"; tokens: string[] } | { kind: "change"; from: string[]; to: string[] };

const isSpace = (token: string) => /^\s+$/u.test(token);
const isWord = (token: string) => /^[\p{L}\p{M}\p{N}]/u.test(token);
const isPunctuation = (token: string) => !isSpace(token) && !isWord(token);

export function diffHunks(original: string, corrected: string): Hunk[] {
  if (original === corrected) return [];
  const segments = tidy(align(tokenize(original), tokenize(corrected)));

  const hunks: Hunk[] = [];
  let offset = 0;
  for (const segment of segments) {
    if (segment.kind === "same") {
      offset += segment.tokens.join("").length;
      continue;
    }
    const before = segment.from.join("");
    hunks.push({ start: offset, end: offset + before.length, original: before, replacement: segment.to.join("") });
    offset += before.length;
  }
  return hunks;
}

// Splits both token lists into alternating unchanged and changed segments.
function align(a: string[], b: string[]): Segment[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const segments: Segment[] = [];
  if (head > 0) segments.push({ kind: "same", tokens: a.slice(0, head) });

  const pairs = midA.length * midB.length <= MAX_TABLE_CELLS ? commonPairs(midA, midB) : [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [midA.length, midB.length] as const]) {
    if (pi > i || pj > j) segments.push({ kind: "change", from: midA.slice(i, pi), to: midB.slice(j, pj) });
    if (pi < midA.length) segments.push({ kind: "same", tokens: [midA[pi]] });
    i = pi + 1;
    j = pj + 1;
  }

  if (tail > 0) segments.push({ kind: "same", tokens: a.slice(a.length - tail) });
  return segments;
}

// Index pairs of a longest common subsequence, in increasing order. Ties skip
// the original's token first, so a replaced word reads as one change.
function commonPairs(a: string[], b: string[]): [number, number][] {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  return pairs;
}

// Makes changes usable as suggestions: neighbouring changes that depend on each
// other become one, and a change never starts or ends with whitespace or has
// an empty side (a missing word is shown with the word next to it). Repeats
// until nothing moves, because one step can bring two changes together.
function tidy(input: Segment[]): Segment[] {
  let segments = normalize(input);
  for (;;) {
    const merged = normalize(fuse(segments));
    const extended = normalize(extend(merged));
    if (JSON.stringify(extended) === JSON.stringify(segments)) return extended;
    segments = extended;
  }
}

// Drops empty segments and joins neighbours of the same kind.
function normalize(input: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const segment of input) {
    const last = out[out.length - 1];
    if (segment.kind === "same") {
      if (segment.tokens.length === 0) continue;
      if (last?.kind === "same") last.tokens = [...last.tokens, ...segment.tokens];
      else out.push({ kind: "same", tokens: [...segment.tokens] });
    } else {
      if (segment.from.length === 0 && segment.to.length === 0) continue;
      if (last?.kind === "change") {
        last.from = [...last.from, ...segment.from];
        last.to = [...last.to, ...segment.to];
      } else out.push({ kind: "change", from: [...segment.from], to: [...segment.to] });
    }
  }
  return out;
}

function fuse(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (let k = 0; k < segments.length; k++) {
    const segment = segments[k];
    const last = out[out.length - 1];
    const next = segments[k + 1];
    if (
      segment.kind === "same" && last?.kind === "change" && next?.kind === "change" &&
      segment.tokens.filter((t) => !isSpace(t)).length <= MAX_MERGE_GAP
    ) {
      last.from = [...last.from, ...segment.tokens, ...next.from];
      last.to = [...last.to, ...segment.tokens, ...next.to];
      k++;
    } else {
      out.push(segment.kind === "same" ? { kind: "same", tokens: [...segment.tokens] }
        : { kind: "change", from: [...segment.from], to: [...segment.to] });
    }
  }
  return out;
}

function extend(segments: Segment[]): Segment[] {
  const out = segments.map((s): Segment => s.kind === "same" ? { kind: "same", tokens: [...s.tokens] }
    : { kind: "change", from: [...s.from], to: [...s.to] });
  for (let k = 0; k < out.length; k++) {
    const change = out[k];
    if (change.kind !== "change") continue;
    const before = out[k - 1]?.kind === "same" ? out[k - 1] as { kind: "same"; tokens: string[] } : undefined;
    const after = out[k + 1]?.kind === "same" ? out[k + 1] as { kind: "same"; tokens: string[] } : undefined;
    const left = () => { const t = before!.tokens.pop()!; change.from.unshift(t); change.to.unshift(t); };
    const right = () => { const t = after!.tokens.shift()!; change.from.push(t); change.to.push(t); };

    for (;;) {
      const lead = isSpace(change.from[0] ?? "x") || isSpace(change.to[0] ?? "x");
      const trail = isSpace(change.from[change.from.length - 1] ?? "x") || isSpace(change.to[change.to.length - 1] ?? "x");
      const empty = change.from.length === 0 || change.to.length === 0;
      const side = change.from.length === 0 ? change.to : change.from;
      const canLeft = (before?.tokens.length ?? 0) > 0;
      const canRight = (after?.tokens.length ?? 0) > 0;
      if (lead && canLeft) left();
      // A comma or full stop belongs to the word before it.
      else if (empty && side.every(isPunctuation) && canLeft) left();
      else if ((trail || empty) && canRight) right();
      else if (empty && canLeft) left();
      else break;
    }
  }
  return out;
}
