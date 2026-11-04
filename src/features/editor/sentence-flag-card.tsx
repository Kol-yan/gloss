"use client";

import type { FocusEvent } from "react";
import { Button } from "@/components/ui/button";
import { AlertIcon, ErrorIcon, EyeIcon, Spinner, SwapIcon } from "@/components/ui/icons";
import { FLAG_LABEL, type FlagCategory, type SentenceFlag } from "./sentence-detect";

// What the generator is doing for a flagged sentence. No entry means it has not been asked.
export type SentenceJobState = "analyzing" | "failed" | "quota" | "unavailable";

// Icon and colour differ per badge, so no category depends on hue alone.
const BADGE: Record<FlagCategory, { className: string; Icon: typeof ErrorIcon }> = {
  correction: { className: "bg-error-soft text-error", Icon: ErrorIcon },
  clarity: { className: "bg-info-soft text-info", Icon: EyeIcon },
  word_choice: { className: "bg-caution-soft text-caution", Icon: SwapIcon },
};

const JOB_MESSAGE: Record<Exclude<SentenceJobState, "analyzing">, string> = {
  failed: "We couldn't review this sentence just now.",
  quota: "You've used all of today's AI checks. They come back tomorrow.",
  unavailable: "AI checking isn't available today.",
};

const EXCERPT_LENGTH = 110;

export function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= EXCERPT_LENGTH) return flat;
  return `${flat.slice(0, EXCERPT_LENGTH).trimEnd()}…`;
}

export function SentenceFlagCard({
  flag,
  job,
  active,
  onActivate,
  onDeactivate,
  onFocusCard,
  onDismiss,
}: {
  flag: SentenceFlag;
  job?: SentenceJobState;
  active: boolean;
  onActivate: (id: string) => void;
  onDeactivate: (id: string) => void;
  onFocusCard: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const analyzing = job === "analyzing";

  const handleBlur = (event: FocusEvent<HTMLLIElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDeactivate(flag.id);
  };

  return (
    <li
      data-flag-card={flag.id}
      aria-busy={analyzing || undefined}
      onMouseEnter={() => onActivate(flag.id)}
      onMouseLeave={() => onDeactivate(flag.id)}
      onFocus={() => {
        onActivate(flag.id);
        onFocusCard(flag.id);
      }}
      onBlur={handleBlur}
      className={
        "rounded-tile border bg-card p-3 transition-colors duration-150 " +
        (active ? "border-accent bg-accent-soft/40 ring-2 ring-accent/30" : "border-line")
      }
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {flag.categories.map((category) => {
          const { className, Icon } = BADGE[category];
          return (
            <span
              key={category}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold ${className}`}
            >
              <Icon size={14} />
              {FLAG_LABEL[category]}
            </span>
          );
        })}
      </div>

      <p className="mt-2 text-sm leading-snug text-ink-muted [overflow-wrap:anywhere]">
        <span className="sr-only">Sentence: </span>
        &ldquo;{excerpt(flag.text)}&rdquo;
      </p>

      <div className="mt-2 flex items-start justify-between gap-2">
        {analyzing ? (
          <p role="status" className="flex items-center gap-1.5 text-sm font-medium text-ink-muted">
            <Spinner size={14} />
            Analyzing…
          </p>
        ) : job ? (
          <p role={job === "failed" ? "alert" : "status"} className="flex items-start gap-1.5 text-sm leading-snug text-caution">
            <AlertIcon size={14} className="mt-0.5 shrink-0" />
            <span>{JOB_MESSAGE[job]}</span>
          </p>
        ) : (
          <p className="text-xs leading-snug text-ink-muted">Preparing analysis…</p>
        )}
        <Button
          size="sm"
          variant="quiet"
          disabled={analyzing}
          onClick={() => onDismiss(flag.id)}
          aria-label={`Dismiss: ${excerpt(flag.text).slice(0, 40)}`}
          className="-my-1 shrink-0"
        >
          Dismiss
        </Button>
      </div>
    </li>
  );
}
