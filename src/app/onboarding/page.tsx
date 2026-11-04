import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Onboarding, OnboardingSignIn } from "@/features/onboarding/onboarding";
import { requireLearner } from "@/server/auth/request";
import { UnauthorizedError } from "@/server/errors";
import { hasCompletedOnboarding } from "@/server/learning/onboarding/completion";

export const metadata: Metadata = { title: "Get started" };

export default function OnboardingPage() {
  return <Suspense fallback={<p role="status" className="p-6 text-ink-muted">Getting ready…</p>}><OnboardingContent /></Suspense>;
}

async function OnboardingContent() {
  await connection();
  let learner;
  try { learner = await requireLearner(); }
  catch (error) {
    if (error instanceof UnauthorizedError) return <OnboardingSignIn />;
    throw error;
  }
  if (hasCompletedOnboarding(learner.id)) redirect("/practice");
  return <Onboarding key={learner.id} />;
}
