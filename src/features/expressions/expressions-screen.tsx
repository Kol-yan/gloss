import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { VerdictBadge } from "@/features/practice/feedback-panel";
import type { ExpressionHistory, HistoryEntry } from "./types";

const KIND_LABEL: Record<HistoryEntry["kind"], string> = {
  assisted: "Used with help",
  written: "Written attempt",
  spoken: "Spoken attempt",
};

// History per expression, newest first. No percentages or levels: only what the
// learner did and when.
export function ExpressionsScreen({ items }: { items: ExpressionHistory[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        eyebrow="My expressions"
        title="No expressions yet"
        action={
          <Link href="/" className={buttonClasses("primary")}>
            Open the editor
          </Link>
        }
      >
        Expressions you accept in the editor appear here, with what you did with each one.
      </EmptyState>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-4">
      <p className="eyebrow">History</p>
      <h1 className="mt-1 text-3xl font-semibold leading-tight tracking-tight">My expressions</h1>
      <ul className="mt-4 flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.id}>
            <section
              aria-labelledby={`expr-${item.id}`}
              className="rounded-tile border border-line bg-card px-4 py-3 shadow-card"
            >
              <h2 id={`expr-${item.id}`} className="text-xl font-semibold leading-tight [overflow-wrap:anywhere]">
                {item.expression}
              </h2>
              <p className="text-sm leading-snug text-ink-muted">{item.meaning}</p>

              <ul className="mt-2 divide-y divide-line">
                {item.entries.map((entry) => (
                  <li key={entry.id} className="flex min-h-11 items-center justify-between gap-3 py-1.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-base font-medium">{KIND_LABEL[entry.kind]}</span>
                      {entry.verdict ? <VerdictBadge verdict={entry.verdict} /> : null}
                    </div>
                    <span className="shrink-0 text-sm text-ink-muted">{entry.whenLabel}</span>
                  </li>
                ))}
              </ul>

              {item.nextPracticeLabel ? (
                <p className="mt-2 border-t border-line pt-2 text-sm font-semibold">
                  Next practice: <span className="font-normal text-ink-muted">{item.nextPracticeLabel}</span>
                </p>
              ) : null}
            </section>
          </li>
        ))}
      </ul>
    </div>
  );
}
