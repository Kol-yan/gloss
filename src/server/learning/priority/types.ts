// The word engine: statuses, session slots and frequency bands.
//
// A "word" is one ranked unit: a saved expression, a starter entry or a word
// the learner marked as known in Word check. The engine never shows a score;
// it shows one short reason ("why") so the practice screen can answer
// "Why this word?" without exposing an ordering.
//
// Bands and levels are shared with the curated starter set and are declared
// once in `src/shared/contracts.ts`; this module re-exports them so server code
// has a single import.

import type {
  FrequencyBand,
  SessionSlot,
  WordStatus,
} from "@/shared/contracts";

export type { FrequencyBand, SessionSlot, WordStatus };

// Where a word came from. The union is closed so a typo cannot create a new
// source that quietly changes priority.
export type WordSource = "saved" | "starter" | "word_check" | "added";

export interface SessionWord {
  expressionId: string;
  text: string;
  slot: SessionSlot;
  status: WordStatus;
  startRung: 1 | 2 | 3 | 4 | 5 | 6;
  frequency: FrequencyBand;
  why: string;
}

export type Reaction = "already_know" | "too_easy" | "not_relevant" | "too_hard";

export interface PracticeResultInput {
  learnerId: string;
  expressionId: string;
  rung: number;
  productive: boolean;
  correct: boolean;
  usedHint: boolean;
  // A reaction may accompany an answer in direct engine use. Practice sessions
  // apply later reactions through recordPracticeReaction instead.
  reaction?: Reaction;
  // Practice sessions use the stable item id so a later reaction annotates
  // the answer event that created that item.
  eventId?: string;
}

export interface PracticeResult {
  status: WordStatus;
  nextRung: number;
  comesBackAt: string;
}

export type StoredWordCheckAnswer =
  | "use"
  | "know_unused"
  | "not_sure"
  | "new";

// A word as it is stored, with the facts the rules need and nothing else.
// `deepKnown` counts Word check "not sure" answers; `bland` counts "too easy"
// reactions. Both lift a word in the order; neither is shown to the learner.
export interface StoredWord {
  expressionId: string;
  learnerId: string;
  text: string;
  normalized: string;
  source: WordSource;
  status: WordStatus;
  band: FrequencyBand;
  rung: number;
  productiveAnswers: number;
  realUseCount: number;
  // Distinct documents and days with independent writing evidence. They are
  // stored so the same document never counts twice.
  realUseDocuments: number;
  realUseDays: number;
  realUseLastAt: string | null;
  // The Word check answer that created the row, when it came from Word check.
  wordCheckAnswer: StoredWordCheckAnswer | null;
  consecutiveErrors: number;
  answers: number;
  correctAnswers: number;
  deepKnown: number;
  bland: number;
  lastPracticedAt: string | null;
  nextAt: string | null;
  // The day this word took a brand-new place, for the daily cap.
  introducedOn: string | null;
  createdAt: string;
}

export const RUNG_MIN = 1;
export const RUNG_MAX = 6;

// The practice ladder: learn from recognition up, activate from production.
export const DEFAULT_RUNG = 1;
export const FIRST_PRODUCTIVE_RUNG = 2;

// Session shape, from the owner decisions of Nov 3.
export const SESSION_SIZE = 8;
export const SLOT_CAPACITY: Record<SessionSlot, number> = {
  activate: 3,
  learn: 3,
  keep: 2,
};
// Brand-new words per day (a "deep" first meeting, not a confident "I know the
// meaning").
export const BRAND_NEW_PER_DAY = 3;
// Reviews that are due before new words are held back.
export const REVIEW_BACKLOG = 6;
// Accuracy (over a small sample) below this holds new words back.
export const WEAK_ACCURACY = 0.5;
export const WEAK_MIN_ANSWERS = 4;
// Active words that come back for one rare check.
export const RARE_CHECK_DAYS = 14;
