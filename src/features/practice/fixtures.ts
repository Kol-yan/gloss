// Sample practice data for the dev-only gallery. Not model output; never import from a real page.
import type { Evaluation, PracticeTask, SubmitAnswer, Verdict } from "./types";

export const SAMPLE_WRITTEN_TASK: PracticeTask = {
  id: "sample-written",
  expressionId: "sample-expression",
  kind: "written",
  cue: "shown",
  expression: "push back",
  meaning: "To move something to a later time.",
  situation: "Your manager wants to start the project on Monday, but your team is not ready. Ask for a later start.",
  hint: "Use a two-word expression that means \"move to a later date\".",
  attemptId: "sample-attempt-1",
};

// The same situation with the expression hidden: the learner has to recall it.
export const SAMPLE_HIDDEN_TASK: PracticeTask = {
  ...SAMPLE_WRITTEN_TASK,
  id: "sample-hidden",
  cue: "hidden",
  expression: null,
  attemptId: "sample-attempt-2",
};

export const SAMPLE_VOICE_TASK: PracticeTask = {
  ...SAMPLE_WRITTEN_TASK,
  id: "sample-voice",
  kind: "voice",
  situation: "A colleague asks if Friday's meeting can still happen. You need more time. Tell them in your own words.",
  attemptId: "sample-attempt-3",
};

export const SAMPLE_ANSWER = "Could we push back the start date until next Thursday?";

const base: Omit<Evaluation, "verdict" | "message" | "correction"> = {
  attemptId: "sample-attempt-1",
  targetUsed: true,
  transcriptEdited: false,
  nextPracticeLabel: "Tomorrow",
  retryAttemptId: "sample-attempt-retry",
};

export const SAMPLE_EVALUATIONS: Record<Verdict, Evaluation> = {
  used_well: {
    ...base,
    verdict: "used_well",
    message: "You used \"push back\" correctly and the sentence sounds natural.",
    correction: null,
    retryAttemptId: null,
  },
  almost: {
    ...base,
    verdict: "almost",
    message: "Good idea, but \"push back\" needs the thing you are moving.",
    correction: "Could we push the start date back until next Thursday?",
  },
  not_yet: {
    ...base,
    verdict: "not_yet",
    message: "This sentence does not use \"push back\" yet. Try to use it to ask for a later date.",
    correction: "Could we push back the start date by a week?",
    targetUsed: false,
  },
  unavailable: {
    ...base,
    verdict: "unavailable",
    message: "We couldn't check this answer. It wasn't counted either way.",
    correction: null,
    targetUsed: false,
    nextPracticeLabel: null,
  },
};

// Stands in for the attempts endpoint in the gallery.
export const sampleSubmit: SubmitAnswer = async ({ answer }) => {
  await new Promise((resolve) => setTimeout(resolve, 800));
  return /push(ed|ing)? back|push\b.+\bback/i.test(answer) ? SAMPLE_EVALUATIONS.used_well : SAMPLE_EVALUATIONS.not_yet;
};
