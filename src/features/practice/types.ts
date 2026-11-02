// View-model types for practice. They describe what the screens need; the
// server contracts for tasks and evaluation do not exist yet and should be
// mapped onto these (or these onto the contracts) when the API is wired.

export type Familiarity = "new" | "known_unused" | "used";

export const FAMILIARITY_OPTIONS: ReadonlyArray<{ value: Familiarity; label: string }> = [
  { value: "new", label: "New to me" },
  { value: "known_unused", label: "I know it but don't use it" },
  { value: "used", label: "I use it" },
];

// Offered after the learner accepts a suggestion worth learning.
export type PracticeOffer = {
  suggestionId: string;
  expression: string;
  // One short line in plain English.
  meaning: string;
};

// "unavailable" means the model could not judge the answer. It is never a
// verdict on the learner and is never counted.
export type Verdict = "used_well" | "almost" | "not_yet" | "unavailable";

export const VERDICT_LABEL: Record<Verdict, string> = {
  used_well: "Used well",
  almost: "Almost",
  not_yet: "Not yet",
  unavailable: "Couldn't check",
};

export type PracticeFeedback = {
  verdict: Verdict;
  // One sentence of feedback.
  message: string;
  // One corrected line, when the answer needs it.
  correction?: string;
};

export type PracticeTask = {
  id: string;
  kind: "written" | "voice";
  expression: string;
  meaning: string;
  // A short situation the learner answers in their own words.
  situation: string;
};
