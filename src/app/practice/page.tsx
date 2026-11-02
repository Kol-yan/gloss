import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingState } from "@/components/load-states";
import { PracticeRoute } from "@/features/practice/practice-route";

export const metadata: Metadata = { title: "Practice" };

export default function PracticePage() {
  // The query string is only known in the browser, hence the boundary.
  return (
    <Suspense fallback={<LoadingState label="Loading practice" />}>
      <PracticeRoute />
    </Suspense>
  );
}
