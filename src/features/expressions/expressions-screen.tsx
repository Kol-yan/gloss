import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { VocabularyPronunciation } from "@/components/vocabulary-pronunciation";
import { VerdictBadge } from "@/features/practice/feedback-panel";
import type { ExpressionHistory, HistoryEntry, HistoryEntryKind } from "@/shared/contracts";

const KIND_LABEL: Record<HistoryEntryKind, string> = {
  assisted_use: "Used with help",
  written_attempt: "Written attempt",
  spoken_attempt: "Spoken attempt",
};

// Small facts about how an attempt went. They are never scores.
function entryNotes(entry: HistoryEntry): string[] {
  const notes: string[] = [];
  if (entry.cue === "hidden") notes.push("From memory");
  if (entry.hintUsed) notes.push("Hint used");
  if (entry.transcriptEdited) notes.push("Transcript edited");
  return notes;
}

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
        {items.map((item) => {
          const { expression } = item;
          return (
            <li key={expression.id}>
              <section
                aria-labelledby={`expr-${expression.id}`}
                className="rounded-tile border border-line bg-card px-4 py-3 shadow-card"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 id={`expr-${expression.id}`} className="text-xl font-semibold leading-tight [overflow-wrap:anywhere]">
                      {expression.text}
                    </h2>
                    <VocabularyPronunciation text={expression.text} ipa={expression.ipa} />
                    <p className="text-sm leading-snug text-ink-muted">{expression.meaning}</p>
                  </div>
                  {item.due ? (
                    <Link
                      href={`/practice?expression=${encodeURIComponent(expression.id)}`}
                      className={buttonClasses("soft", "sm", "shrink-0")}
                    >
                      Practice now
                    </Link>
                  ) : null}
                </div>

                <ul className="mt-2 divide-y divide-line">
                  {item.entries.map((entry, index) => {
                    const notes = entryNotes(entry);
                    return (
                      <li key={index} className="flex min-h-11 items-center justify-between gap-3 py-1.5">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="text-base font-medium">{KIND_LABEL[entry.kind]}</span>
                          {entry.verdict && entry.verdict !== "unavailable" ? <VerdictBadge verdict={entry.verdict} /> : null}
                          {notes.length > 0 ? <span className="text-xs text-ink-muted">{notes.join(" · ")}</span> : null}
                        </div>
                        <span className="shrink-0 text-sm text-ink-muted">{entry.dayLabel}</span>
                      </li>
                    );
                  })}
                </ul>

                {item.nextPracticeLabel ? (
                  <p className="mt-2 border-t border-line pt-2 text-sm font-semibold">
                    Next practice: <span className="font-normal text-ink-muted">{item.nextPracticeLabel}</span>
                  </p>
                ) : null}
              </section>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
