import { connection } from "next/server";
import { requireLearner } from "@/server/auth/request";
import { UnauthorizedError } from "@/server/errors";
import { hasCompletedOnboarding } from "@/server/learning/onboarding/completion";
import { Landing } from "./landing";

// The first action on the landing page depends on whether this visitor has already
// finished onboarding: a finished learner goes straight to practice.
export async function LandingFlow() {
  await connection();
  let startPracticeHref = "/onboarding";
  try {
    const learner = await requireLearner();
    if (hasCompletedOnboarding(learner.id)) startPracticeHref = "/practice";
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
  }
  return <Landing startPracticeHref={startPracticeHref} />;
}
