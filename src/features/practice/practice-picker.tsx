"use client";

import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { VocabularyPronunciation } from "@/components/vocabulary-pronunciation";
import { AccessUnavailable } from "@/components/invite-required";
import { LoadError, LoadingState } from "@/components/load-states";
import { isUnauthorized, listExpressions } from "@/features/api/client";
import { useLoad } from "@/features/api/use-load";

// Shown at /practice without an expression: what is due now, or an honest empty state.
export function PracticePicker() {
  const { result, reload } = useLoad(listExpressions);

  if (!result) return <LoadingState label="Loading your expressions" />;

  if (!result.ok) {
    if (isUnauthorized(result)) return <AccessUnavailable />;
    return (
      <LoadError title="We couldn't load your expressions" onRetry={reload}>
        Check your connection and try again.
      </LoadError>
    );
  }

  const all = result.data.expressions;
  const due = all.filter((item) => item.due);

  if (all.length === 0) {
    return (
      <EmptyState
        eyebrow="Practice"
        title="Nothing to practice yet"
        action={
          <Link href="/editor" className={buttonClasses("primary")}>
            Open the editor
          </Link>
        }
      >
        Practice starts when you accept an expression suggestion in the editor and choose to try it yourself.
      </EmptyState>
    );
  }

  if (due.length === 0) {
    const soonest = all.find((item) => item.nextPracticeLabel)?.nextPracticeLabel;
    return (
      <EmptyState
        eyebrow="Practice"
        title="Nothing is due right now"
        action={
          <Link href="/expressions" className={buttonClasses("primary")}>
            See my expressions
          </Link>
        }
      >
        {soonest ? `Next practice: ${soonest}.` : "Come back later."}
      </EmptyState>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-4">
      <p className="eyebrow">Practice</p>
      <h1 className="mt-1 text-3xl font-semibold leading-tight tracking-tight">Ready to practice</h1>
      <ul className="mt-4 flex flex-col gap-3">
        {due.map((item) => (
          <li
            key={item.expression.id}
            className="flex items-center justify-between gap-3 rounded-tile border border-line bg-card px-4 py-3 shadow-card"
          >
            <div className="min-w-0">
              <p className="text-xl font-semibold leading-tight [overflow-wrap:anywhere]">{item.expression.text}</p>
              <VocabularyPronunciation text={item.expression.text} ipa={item.expression.ipa} />
              <p className="text-sm leading-snug text-ink-muted">{item.expression.meaning}</p>
            </div>
            <Link
              href={`/practice?expression=${encodeURIComponent(item.expression.id)}`}
              className={buttonClasses("primary", "md", "shrink-0")}
            >
              Practice now
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
