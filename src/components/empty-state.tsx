import type { ReactNode } from "react";

// One eyebrow, one heading, one sentence, one action. Used wherever a screen has nothing to show yet.
export function EmptyState({
  eyebrow,
  title,
  children,
  action,
  className = "",
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  action: ReactNode;
  className?: string;
}) {
  return (
    <div className={"mx-auto flex w-full max-w-md flex-col items-center gap-3 px-4 py-10 text-center " + className}>
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="text-balance text-3xl font-semibold leading-tight tracking-tight">{title}</h1>
      <p className="text-pretty text-base leading-relaxed text-ink-muted">{children}</p>
      <div className="mt-2">{action}</div>
    </div>
  );
}
