import type { Metadata } from "next";
import { Suspense } from "react";
import { PracticeSession, PracticeSessionLoading } from "@/components/practice-session";
import { PracticeRoute } from "@/features/practice/practice-route";
import type { PracticeFixtureName } from "@/lib/practice-session-fixtures";

export const metadata: Metadata = { title: "Practice" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FIXTURES: PracticeFixtureName[] = [
  "flow", "preparing", "recognise", "meaning", "gap", "recall", "correct", "wrong", "end", "waiting", "error",
];

function fixtureName(value: string | string[] | undefined): PracticeFixtureName | undefined {
  if (typeof value !== "string") return undefined;
  return FIXTURES.includes(value as PracticeFixtureName) ? value as PracticeFixtureName : undefined;
}

export default function PracticePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<PracticeSessionLoading label="Preparing your practice." />}>
      <PracticePageContent searchParams={searchParams} />
    </Suspense>
  );
}

async function PracticePageContent({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const expressionId = typeof query.expression === "string" ? query.expression : undefined;
  if (expressionId) return <PracticeRoute />;

  const fixture = process.env.NODE_ENV !== "production" ? fixtureName(query.fixture) : undefined;
  return <PracticeSession initialFixture={fixture} />;
}
