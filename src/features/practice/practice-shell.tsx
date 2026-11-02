import type { ReactNode } from "react";
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

// The expression being practised and, optionally, the situation to answer.
export function TaskCard({
  task,
  withSituation = true,
  label,
}: {
  task: PracticeTask;
  withSituation?: boolean;
  label: string;
}) {
  return (
    <section aria-label="Task" className="rounded-tile border border-line bg-card px-4 py-3 shadow-card">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow whitespace-nowrap">Use this expression</p>
        <p className="whitespace-nowrap text-xs font-semibold text-ink-muted">{label}</p>
      </div>
      <p className="mt-1 text-xl font-semibold leading-tight [overflow-wrap:anywhere]">{task.expression}</p>
      <p className="text-sm leading-snug text-ink-muted">{task.meaning}</p>
      {withSituation ? (
        <p className="mt-2.5 border-t border-line pt-2.5 text-base leading-6 @md:text-lg @md:leading-7">{task.situation}</p>
      ) : null}
    </section>
  );
}
