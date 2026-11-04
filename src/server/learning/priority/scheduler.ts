// Priority and the session mix. Pure: takes stored words, a clock and a few
// counts, and returns the words in order. The learner sees one short reason,
// never the numbers behind the order.

import type {
  FrequencyBand,
  SessionSlot,
  SessionWord,
  StoredWord,
} from "./types";
import {
  BRAND_NEW_PER_DAY as NEW_WORDS_PER_DAY,
  REVIEW_BACKLOG,
  SESSION_SIZE,
  SLOT_CAPACITY,
  WEAK_ACCURACY,
} from "./types";

// Higher first. Frequency is the objective signal; relevance is what the
// learner did; progress decides which end of the path to work on.
const BAND_WEIGHT: Record<FrequencyBand, number> = {
  core: 3,
  common: 2,
  uncommon: 1,
  rare: 0,
};

const SOURCE_RELEVANCE = { saved: 2, added: 2, word_check: 1, starter: 0 } as const;

// Words on the edge between passive and active belong at the top: this rule
// compares before anything else.
const EDGE_BONUS = { ready: 100 } as const;

export interface PriorityContext {
  now: Date;
  // Words introduced as brand new on the current day (UTC).
  brandNewToday: number;
  // Reviews that are due now and not yet selected.
  reviewBacklog: number;
  // The learner's recent answer share over every word.
  accuracy: number | null;
}

// The numeric order. Exported for tests and for the "Why this word?" tooltip's
// ordering only; it is never shown as a score.
export function priorityScore(word: StoredWord, ctx: PriorityContext): number {
  const nowMs = ctx.now.getTime();
  const overdueDays = word.nextAt
    ? Math.max(0, (nowMs - Date.parse(word.nextAt)) / 86_400_000)
    : 0;
  const edgeBonus = word.status === "ready" ? EDGE_BONUS.ready : 0;
  return (
    edgeBonus +
    BAND_WEIGHT[word.band] * 6 +
    SOURCE_RELEVANCE[word.source] * 5 +
    Math.min(overdueDays, 30) * 2 +
    word.consecutiveErrors * 3 +
    word.deepKnown * 4 +
    word.bland * 2 -
    word.productiveAnswers * 2 -
    word.realUseCount * 6
  );
}

// Short, learner-facing English. No scores, no percentages, no terms the
// learner has not met.
export function reasonFor(word: StoredWord): string {
  const band = BAND_LABEL[word.band];
  switch (word.status) {
    case "ready":
      return `${band} word - you know it but don't use it yet`;
    case "active":
      return word.bland > 0
        ? `${band} word - you said it is easy; a quick check`
        : `${band} word - yours now, just keeping it fresh`;
    case "learning":
      if (word.realUseCount > 0) return `${band} word - you used it once; let's make it stick`;
      if (word.consecutiveErrors > 0) return `${band} word - it slipped last time; a short return`;
      return `${band} word - new for you, start with meaning`;
    case "hidden":
      return `${band} word - hidden for now`;
  }
}

const BAND_LABEL: Record<FrequencyBand, string> = {
  core: "Core",
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
};

// Which slot a word competes in. A word on the edge is always an activation
// target; a brand-new word is a "learn" candidate.
// A brand-new word that has not answered yet is learned under the daily
// allowance; once the learner has answered it, the word stays in learning
// work and no longer competes for the allowance.
export function slotFor(word: StoredWord): SessionSlot {
  if (word.status === "active") return "keep";
  if (word.status === "ready") return "activate";
  if (word.status === "learning") return "learn";
  return "activate";
}

// A brand-new word is one the learner is meeting from scratch: Learning, never
// answered and with no use. A Word check "I know it but don't use it" answer is
// known vocabulary, not a first meeting; "new" and "not sure" are brand new and
// take one of the day's places at Word check time.
export function isBrandNew(word: StoredWord): boolean {
  return (
    word.status === "learning" &&
    word.answers === 0 &&
    word.productiveAnswers === 0 &&
    word.realUseCount === 0 &&
    word.wordCheckAnswer !== "know_unused"
  );
}

// Brand-new words that took one of today's places (UTC).
export function brandNewToday(words: readonly StoredWord[], now: Date): number {
  const day = now.toISOString().slice(0, 10);
  return words.filter((word) => isBrandNew(word) && word.introducedOn === day).length;
}

// How many brand-new words may still start today: three on a calm day, fewer
// when reviews pile up or the last answers went badly.
export function dailyLearnAllowance(ctx: Pick<PriorityContext, "brandNewToday" | "reviewBacklog" | "accuracy">): number {
  const base = NEW_WORDS_PER_DAY;
  const left = Math.max(0, base - ctx.brandNewToday);
  if (left === 0) return 0;
  const weak = ctx.accuracy !== null && ctx.accuracy < WEAK_ACCURACY;
  if (ctx.reviewBacklog >= REVIEW_BACKLOG || weak) return Math.min(left, 1);
  return left;
}

export interface SelectionInput {
  // Candidate words, already limited to this learner.
  words: readonly StoredWord[];
  // How many new words were introduced today, before this session.
  brandNewToday: number;
  // Recent answer accuracy over the learner's words; null with no answers.
  accuracy: number | null;
  now: Date;
  size?: number;
}

// Pick the session: 3 activate, 3 learn (at most the daily allowance), 2 keep,
// with the remaining seats filled from whatever else is due. Words on the edge
// always come before everything else inside their slot.
export function pickWords(input: SelectionInput): SessionWord[] {
  const size = Math.max(0, Math.min(64, Math.floor(input.size ?? SESSION_SIZE)));
  const now = input.now;
  const nowMs = now.getTime();

  const eligible = input.words.filter((word) => word.status !== "hidden");
  const due = (word: StoredWord) => !word.nextAt || Date.parse(word.nextAt) <= nowMs;

  const baseCtx: Omit<PriorityContext, "reviewBacklog"> = {
    now,
    brandNewToday: input.brandNewToday,
    accuracy: input.accuracy,
  };
  // Words that are waiting for a review: started learning, edge and active
  // words. Brand-new starter words are not reviews.
  const backlog = eligible.filter(
    (word) =>
      !isBrandNew(word) &&
      ((word.status === "ready" && due(word)) ||
        (word.status === "active" && due(word)) ||
        (word.status === "learning" && word.answers > 0 && due(word))),
  ).length;
  const ctx: PriorityContext = { ...baseCtx, reviewBacklog: backlog };

  const ordered = [...eligible].sort((a, b) => compareWords(a, b, ctx));

  const picked: StoredWord[] = [];
  const pickedIds = new Set<string>();
  // The group a word was taken for. A word from the tail keeps the group whose
  // seat it filled, so a top-up never turns a review into a "new word".
  const pickedSlot = new Map<string, SessionSlot>();
  const take = (word: StoredWord, slot: SessionSlot = slotFor(word)) => {
    if (picked.length >= size || pickedIds.has(word.expressionId)) return;
    picked.push(word);
    pickedIds.add(word.expressionId);
    pickedSlot.set(word.expressionId, slot);
  };

  const countIn = (slot: SessionSlot) =>
    [...pickedSlot.values()].filter((pickedGroup) => pickedGroup === slot).length;

  // `take` never adds a word twice or beyond the session size.
  const canTake = (word: StoredWord) =>
    !pickedIds.has(word.expressionId) && picked.length < size;

  // 1. Edge words first, inside the activate seats. These are the words the
  //    learner knows but does not use: the point of the session.
  for (const word of ordered) {
    if (countIn("activate") >= SLOT_CAPACITY.activate) break;
    if (slotFor(word) !== "activate" || isBrandNew(word)) continue;
    take(word);
  }

  // 2. New words, limited by the daily allowance and the learn seats.
  let allowance = dailyLearnAllowance({
    brandNewToday: input.brandNewToday,
    reviewBacklog: backlog,
    accuracy: input.accuracy,
  });
  for (const word of ordered) {
    if (allowance <= 0) break;
    if (countIn("learn") >= SLOT_CAPACITY.learn) break;
    if (slotFor(word) !== "learn") continue;
    if (!isBrandNew(word) || !canTake(word)) continue;
    take(word);
    allowance -= 1;
  }

  // 3. Keep fresh: active words whose check is due.
  for (const word of ordered) {
    if (countIn("keep") >= SLOT_CAPACITY.keep) break;
    if (slotFor(word) !== "keep" || !due(word) || !canTake(word)) continue;
    take(word);
  }

  // 4. Started learning words are reviews, not new words: the allowance does
  //    not apply and they fill the free learn seats.
  for (const word of ordered) {
    if (countIn("learn") >= SLOT_CAPACITY.learn) break;
    if (slotFor(word) !== "learn" || isBrandNew(word) || !canTake(word)) continue;
    take(word);
  }

  // 5. Fill free seats from the right group only: activation work for
  //    activate (overdue and edge words), due checks for keep. A brand-new
  //    word never moves to another group, so the daily places hold.
  const fillSeat = (seat: "activate" | "keep") => {
    while (countIn(seat) < SLOT_CAPACITY[seat] && picked.length < size) {
      const candidate = ordered.find((word) => {
        if (!canTake(word) || slotFor(word) !== seat) return false;
        if (seat === "activate") return word.status === "ready" || (due(word) && !isBrandNew(word));
        return due(word);
      });
      if (!candidate) return;
      take(candidate, seat);
    }
  };
  fillSeat("activate");
  fillSeat("keep");

  // 6. A learner who is caught up (only brand-new words left) gets one of the
  //    words that are already started or due in another group, never a hidden
  //    word and never an extra new word per day.
  const tail = ordered.filter(
    (word) =>
      !isBrandNew(word) &&
      (word.status === "ready" ||
        (word.status === "learning" && word.answers > 0) ||
        (slotFor(word) === "keep" && due(word))),
  );
  for (const word of tail) {
    if (!canTake(word)) continue;
    take(word, slotFor(word) === "keep" ? "keep" : word.status === "ready" ? "activate" : "learn");
  }

  return picked
    .slice(0, size)
    .map((word) => toSessionWord(word, pickedSlot.get(word.expressionId) ?? slotFor(word)));
}

export function toSessionWord(word: StoredWord, slot: SessionSlot): SessionWord {
  return {
    expressionId: word.expressionId,
    text: word.text,
    slot,
    status: word.status,
    startRung: startRungFor(word),
    frequency: word.band,
    why: reasonFor(word),
  };
}

export function startRungFor(word: StoredWord): 1 | 2 | 3 | 4 | 5 | 6 {
  const rung = Math.min(6, Math.max(1, Math.round(word.rung)));
  return rung as 1 | 2 | 3 | 4 | 5 | 6;
}

// Stable order: score desc, then the edge, then frequency, then id. Sorting by
// id last keeps the choice deterministic for identical words.
function compareWords(a: StoredWord, b: StoredWord, ctx: PriorityContext): number {
  const byScore = priorityScore(b, ctx) - priorityScore(a, ctx);
  if (byScore !== 0) return byScore;
  const edge = (a.status === "ready" ? 0 : 1) - (b.status === "ready" ? 0 : 1);
  if (edge !== 0) return edge;
  const byBand = BAND_WEIGHT[a.band] - BAND_WEIGHT[b.band];
  if (byBand !== 0) return byBand;
  return a.expressionId < b.expressionId ? -1 : a.expressionId > b.expressionId ? 1 : 0;
}
