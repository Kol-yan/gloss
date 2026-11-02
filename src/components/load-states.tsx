"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";

// Indeterminate by design: we do not know how long a request takes, so there is no percentage.
export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" className="flex flex-col items-center gap-3 px-4 py-16 text-center">
      <span className="flex items-center gap-1.5" aria-hidden="true">
        {[0, 140, 280].map((delay) => (
          <span key={delay} className="size-2 animate-dot rounded-full bg-accent" style={{ animationDelay: `${delay}ms` }} />
        ))}
      </span>
      <p className="text-base font-semibold">{label}</p>
    </div>
  );
}

// A request failed. Always offers a way forward: retry, or a link when retrying cannot help.
export function LoadError({
  title,
  children,
  onRetry,
  action,
}: {
  title: string;
  children: ReactNode;
  onRetry?: () => void;
  action?: ReactNode;
}) {
  return (
    <EmptyState
      eyebrow="Not right now"
      title={title}
      action={
        action ?? (
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        )
      }
    >
      {children}
    </EmptyState>
  );
}
