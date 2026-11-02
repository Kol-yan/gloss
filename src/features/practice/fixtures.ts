// Sample practice data for the dev-only gallery. Not model output; never import from a real page.
import type { PracticeFeedback, PracticeTask, Verdict } from "./types";

export const SAMPLE_WRITTEN_TASK: PracticeTask = {
  id: "sample-written",
  kind: "written",
  expression: "push back",
  meaning: "To move something to a later time.",
  situation: "Your manager wants to start the project on Monday, but your team is not ready. Ask for a later start.",
};

export const SAMPLE_VOICE_TASK: PracticeTask = {
  ...SAMPLE_WRITTEN_TASK,
  id: "sample-voice",
  kind: "voice",
  situation: "A colleague asks if Friday's meeting can still happen. You need more time. Tell them in your own words.",
};

export const SAMPLE_ANSWER = "Could we push back the start date until next Thursday?";

export const SAMPLE_FEEDBACK: Record<Verdict, PracticeFeedback> = {
  used_well: {
    verdict: "used_well",
    message: "You used \"push back\" correctly and the sentence sounds natural.",
  },
  almost: {
    verdict: "almost",
    message: "Good idea, but \"push back\" needs the thing you are moving.",
    correction: "Could we push the start date back until next Thursday?",
  },
  not_yet: {
    verdict: "not_yet",
    message: "This sentence does not use \"push back\" yet. Try to use it to ask for a later date.",
    correction: "Could we push back the start date by a week?",
  },
  unavailable: {
    verdict: "unavailable",
    message: "We couldn't check this answer. It wasn't counted either way.",
  },
};

// Stands in for the evaluation call in the gallery.
export async function sampleEvaluate(answer: string): Promise<PracticeFeedback> {
  await new Promise((resolve) => setTimeout(resolve, 800));
  return /push(ed|ing)? back|push\b.+\bback/i.test(answer) ? SAMPLE_FEEDBACK.used_well : SAMPLE_FEEDBACK.not_yet;
}
