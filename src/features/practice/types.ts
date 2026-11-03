// Practice types come from the shared contracts so the browser and the server
// agree on one shape. Only UI constants and small mappers live here.
import type { Evaluation, Familiarity, PracticeTask, Suggestion, Verdict } from "@/shared/contracts";

export type { Evaluation, Familiarity, PracticeTask, Verdict };

export const FAMILIARITY_OPTIONS: ReadonlyArray<{ value: Familiarity; label: string }> = [
  { value: "new", label: "New to me" },
  { value: "known_unused", label: "I know it but don't use it" },
  { value: "used", label: "I use it" },
];

export const VERDICT_LABEL: Record<Verdict, string> = {
  used_well: "Used well",
  almost: "Almost",
  not_yet: "Not yet",
  unavailable: "Couldn't check",
};

// What the feedback panel needs from an evaluation.
export type Feedback = Pick<Evaluation, "verdict" | "message" | "correction" | "target" | "ipa">;

// Judges one answer. Never rejects: a failed call comes back as an
// evaluation with verdict "unavailable", which is never counted.
export type SubmitAnswer = (input: { attemptId: string; answer: string; hintUsed: boolean }) => Promise<Evaluation>;

// Offered after the learner accepts a suggestion worth learning.
export type PracticeOffer = {
  suggestionId: string;
  expression: string;
  ipa?: string | null;
  // One short line in plain English.
  meaning: string;
};

// Only AI "expression" suggestions that carry a meaning can become practice.
export function offerFromSuggestion(suggestion: Suggestion): PracticeOffer | null {
  if (suggestion.source !== "ai" || suggestion.category !== "expression") return null;
  if (!suggestion.meaning || suggestion.replacement.trim() === "") return null;
  return { suggestionId: suggestion.id, expression: suggestion.replacement.trim(), meaning: suggestion.meaning, ipa: suggestion.ipa ?? null };
}

// True when this evaluation lets the learner try the same task again.
export function canRetry(evaluation: Evaluation): boolean {
  return evaluation.retryAttemptId !== null;
}

// A failed check reuses the exact answer and attempt. A judged answer gets a new try.
export function retryAttemptFor(evaluation: Evaluation): string | null {
  return evaluation.verdict === "unavailable" ? evaluation.attemptId : evaluation.retryAttemptId;
}
