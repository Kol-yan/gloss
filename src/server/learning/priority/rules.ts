// Status transitions and the practice ladder. Pure: no database, no clock of
// its own; the caller passes the time so every rule is testable.
//
// The status rules from the owner decisions (Nov 3):
// - Active after 2 real-writing uses, or 3 productive answers.
// - Real use outweighs practice: two ordinary uses make a word active at once;
//   three productive answers only while the learner answers correctly.
// - Two errors in a row move a word one step down.
// - Already know: Active with a rare check. Not relevant: Hidden.
// - Too hard: easier rungs. Too easy: straight to productive work.

import {
  DEFAULT_RUNG,
  RARE_CHECK_DAYS,
  RUNG_MAX,
  type PracticeResult,
  type PracticeResultInput,
  type Reaction,
  type StoredWord,
  type WordStatus,
} from "./types";

export const PRODUCTIVE_ANSWERS_TO_ACTIVE = 3;
export const REAL_USES_TO_ACTIVE = 2;
export const ERRORS_TO_STEP_DOWN = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AnswerInput = Omit<PracticeResultInput, "learnerId">;

// The next rung after a correct unassisted answer: every rung lifts by one,
// never past the last step. Rung 1 is the entry rung, so a correct recognition
// moves the word to rung 2 rather than pinning it at the entry step. A hinted
// correct answer does not lift the rung (see recordAnswer); it may still move
// the status to Ready like any correct answer.
export function nextRungUp(rung: number): number {
  if (!Number.isFinite(rung)) return DEFAULT_RUNG;
  const current = clampRung(rung);
  return current >= RUNG_MAX ? RUNG_MAX : current + 1;
}

// One step down, never below the first rung.
export function nextRungDown(rung: number): number {
  const current = clampRung(rung);
  return current <= 1 ? 1 : current - 1;
}

export function clampRung(rung: number): number {
  if (!Number.isFinite(rung)) return DEFAULT_RUNG;
  return Math.min(RUNG_MAX, Math.max(1, Math.round(rung)));
}

function addDays(from: Date, days: number): string {
  return new Date(from.getTime() + days * DAY_MS).toISOString();
}

// An active word comes back for one rare check; the interval narrows as the
// learner produces it more, so a harder word is seen sooner.
export function activeCheckDays(word: Pick<StoredWord, "productiveAnswers">): number {
  return Math.max(7, RARE_CHECK_DAYS - Math.floor(word.productiveAnswers / 3));
}

// Where the word sits once reactions and the answer are applied. The order is
// fixed so the same input always gives the same status.
export interface Outcome {
  status: WordStatus;
  rung: number;
}

export function applyReaction(word: StoredWord, reaction: Reaction | undefined | null): Outcome {
  switch (reaction) {
    case "already_know":
      // Known: active from now, coming back only for a rare check.
      return { status: "active", rung: Math.max(clampRung(word.rung), 3) };
    case "not_relevant":
      return { status: "hidden", rung: clampRung(word.rung) };
    case "too_hard":
      return { status: word.status, rung: nextRungDown(word.rung) };
    case "too_easy":
      // Comfortable: move to productive work straight away; a familiar word is
      // ready to activate rather than back in learning.
      return {
        status: word.status === "active" ? "active" : "ready",
        rung: Math.max(clampRung(word.rung), 2),
      };
    default:
      return { status: word.status, rung: clampRung(word.rung) };
  }
}

// Productive credit after one answer. Only unassisted, correct, productive
// answers count: a hinted answer is assisted work and never independent
// production. A wrong answer that reaches the demotion threshold resets the
// credit, so the same stale answers cannot immediately lift the word back up.
export function productiveAfterAnswer(
  word: StoredWord,
  input: AnswerInput,
  errorsAfter: number,
): number {
  if (errorsAfter >= ERRORS_TO_STEP_DOWN && !input.correct) return 0;
  return word.productiveAnswers + (input.correct && input.productive && !input.usedHint ? 1 : 0);
}

// The status after one recorded answer, before the comeback time. `errors`
// is the streak after this answer (the store keeps it).
export function statusAfterAnswer(
  word: StoredWord,
  input: AnswerInput,
  outcome: Outcome,
  errorsAfter: number,
): WordStatus {
  if (outcome.status === "hidden") return "hidden";
  if (outcome.status === "active" && input.reaction !== "already_know") {
    // Active words are kept by the rare check; two errors in a row send the
    // word back one step to Ready to activate.
    return errorsAfter >= ERRORS_TO_STEP_DOWN ? "ready" : "active";
  }
  if (input.reaction === "already_know" || input.reaction === "too_easy") return outcome.status;
  // Two errors in a row: one step down and never straight back to Active. The
  // word waits for fresh productive work, so the demotion holds even when the
  // old counter or a past real use would have lifted it again.
  if (errorsAfter >= ERRORS_TO_STEP_DOWN) {
    return outcome.status === "ready" ? "learning" : outcome.status === "active" ? "ready" : outcome.status;
  }
  const productiveAnswers = productiveAfterAnswer(word, input, errorsAfter);
  if (word.realUseCount >= REAL_USES_TO_ACTIVE || productiveAnswers >= PRODUCTIVE_ANSWERS_TO_ACTIVE) {
    return "active";
  }
  if (input.correct || outcome.status === "ready") return "ready";
  return "learning";
}

export function comebackAfter(
  word: StoredWord,
  input: AnswerInput,
  outcome: Outcome,
  now: Date,
): string {
  if (outcome.status === "hidden") return addDays(now, 0);
  if (outcome.status === "active") {
    return addDays(now, input.reaction === "too_hard" ? 1 : activeCheckDays(word));
  }
  if (input.reaction === "too_hard" || !input.correct) return addDays(now, 1);
  if (outcome.status === "ready") return addDays(now, 2);
  return addDays(now, input.productive ? 3 : 1);
}

// One recorded answer. `errorsAfter` is passed in so the pure rule can see the
// streak; the store computes it as "0 on a correct answer, +1 otherwise".
export function recordAnswer(
  input: AnswerInput,
  word: StoredWord,
  now: Date,
  errorsAfter: number = input.correct ? 0 : word.consecutiveErrors + 1,
): PracticeResult {
  if (!word) throw new TypeError("recordAnswer requires a stored word");
  const rung0 = clampRung(word.rung);

  // Not relevant hides the word; nothing else happens to it.
  if (input.reaction === "not_relevant") {
    return { status: "hidden", nextRung: rung0, comesBackAt: addDays(now, 0) };
  }
  if (word.status === "hidden") {
    // Only the learner can bring a hidden word back; an answer does not.
    return { status: "hidden", nextRung: rung0, comesBackAt: addDays(now, 0) };
  }

  const reacted = applyReaction(word, input.reaction);
  let rung = reacted.rung;
  if (reacted.rung === rung0) {
    // The answer itself moves the ladder when no reaction decided it. A hinted
    // correct answer is assisted, so it neither lifts the rung nor counts as
    // independent production; it can still move the status to Ready.
    if (input.correct) {
      if (!input.usedHint) rung = nextRungUp(rung0);
    } else if (input.reaction !== "too_hard") {
      rung = nextRungDown(rung0);
    }
  }
  const outcome: Outcome = { status: reacted.status, rung };
  const status = statusAfterAnswer(word, input, outcome, errorsAfter);
  return { status, nextRung: rung, comesBackAt: comebackAfter(word, input, { status, rung }, now) };
}

// Real use in the learner's own writing counts toward Active and outweighs
// practice: two uses make a word active from Learning or Ready at once. A
// hidden word stays hidden, and an already-active word stays active.
export function applyRealUse(word: StoredWord): { status: WordStatus; active: boolean } {
  if (word.status === "hidden") return { status: "hidden", active: false };
  const realUseCount = word.realUseCount + 1;
  const status = word.status === "active" || realUseCount >= REAL_USES_TO_ACTIVE ? "active" : "ready";
  return { status, active: status === "active" };
}
