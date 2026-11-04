// The word engine: which words to practice next and what an answer does to
// them. The interface of track B is exported from here.

export type {
  FrequencyBand,
  PracticeResult,
  PracticeResultInput,
  Reaction,
  SessionSlot,
  SessionWord,
  StoredWord,
  WordSource,
  WordStatus,
} from "./types";
export {
  DEFAULT_RUNG,
  RUNG_MAX,
  RUNG_MIN,
  SESSION_SIZE,
  SLOT_CAPACITY,
} from "./types";

export { pickSessionWords } from "./engine";
export { recordPracticeResult } from "./engine";
// Not part of the track B interface; used by the onboarding and My words
// routes that follow in the morning.
export {
  wordEngineCounts,
  recordRealUse,
  recordWordCheckAnswer,
  seedStarterWords,
} from "./engine";
export {
  applyReaction,
  nextRungDown,
  nextRungUp,
  recordAnswer,
  // Used by recording real use from the Learning tab.
  applyRealUse,
} from "./rules";

export {
  brandNewToday,
  dailyLearnAllowance,
  isBrandNew,
  priorityScore,
  reasonFor,
  slotFor,
  startRungFor,
  toSessionWord,
} from "./scheduler";
export { estimateBand, entryRung, normalizeWord, wordCheckOutcome } from "./intake";
