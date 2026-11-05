import type { Metadata } from "next";
import { Suspense } from "react";
import { Landing } from "@/features/landing/landing";
import { LandingFlow } from "@/features/landing/landing-flow";

export const metadata: Metadata = {
  title: { absolute: "gloss" },
  description:
    "gloss checks your English as you type, everywhere, and turns the words you understand into words you use.",
};

export default function HomePage() {
  return (
    <Suspense fallback={<Landing startPracticeHref="/onboarding" />}>
      <LandingFlow />
    </Suspense>
  );
}
