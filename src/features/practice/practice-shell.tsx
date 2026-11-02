import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { PracticeTask } from "./types";

// Layout shared by written and voice practice: content on top, a rail with the
// actions anchored to the bottom, so the answer and the next step stay in view
// without scrolling. The content area only scrolls as a safety net.
export function PracticeShell({ children, rail }: { children: ReactNode; rail: ReactNode }) {
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 py-3">{children}</div>
      </div>
      <div className="shrink-0 border-t border-line bg-paper px-4 py-2.5">
        <div className="mx-auto flex min-h-11 w-full max-w-2xl items-center justify-between gap-3">{rail}</div>
      </div>
    </div>
  );
}

// The expression being practised (or, when the cue is hidden, only the
// situation) and an optional hint the learner can ask for.
export function TaskCard({
  task,
  withSituation = true,
  label,
  hintShown = false,
  onShowHint,
}: {
  task: PracticeTask;
  withSituation?: boolean;
  label: string;
  hintShown?: boolean;
  onShowHint?: () => void;
}) {
  const hidden = task.cue === "hidden" || task.expression === null;
  return (
    <section aria-label="Task" className="rounded-tile border border-line bg-card px-4 py-3 shadow-card">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow whitespace-nowrap">{hidden ? "Say it in your own words" : "Use this expression"}</p>
        <p className="whitespace-nowrap text-xs font-semibold text-ink-muted">{label}</p>
      </div>
      {hidden ? null : (
        <>
          <p className="mt-1 text-xl font-semibold leading-tight [overflow-wrap:anywhere]">{task.expression}</p>
          <p className="text-sm leading-snug text-ink-muted">{task.meaning}</p>
        </>
      )}
      {withSituation ? (
        <p
          className={
            "text-base leading-6 @md:text-lg @md:leading-7 " + (hidden ? "mt-1" : "mt-2.5 border-t border-line pt-2.5")
          }
        >
          {task.situation}
        </p>
      ) : null}
      {hidden && onShowHint ? (
        hintShown ? (
          <p className="mt-2 rounded-chip bg-surface px-3 py-2 text-sm leading-snug">
            <span className="font-semibold">Hint: </span>
            {task.hint}
          </p>
        ) : (
          <div className="mt-1 -ml-2">
            <Button variant="quiet" size="sm" onClick={onShowHint}>
              Need a hint?
            </Button>
          </div>
        )
      ) : null}
    </section>
  );
}
