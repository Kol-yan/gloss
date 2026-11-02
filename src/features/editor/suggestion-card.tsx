"use client";

import type { FocusEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertIcon,
  BookmarkIcon,
  DeviceIcon,
  ErrorIcon,
  PenIcon,
  SparkIcon,
} from "@/components/ui/icons";
import type { Suggestion, SuggestionCategory, SuggestionSource } from "@/shared/contracts";

// Each category differs in icon, label and colour, so Style and Expression never read as errors.
const CATEGORY: Record<SuggestionCategory, { label: string; className: string; Icon: typeof ErrorIcon }> = {
  error: { label: "Error", className: "bg-error-soft text-error", Icon: ErrorIcon },
  style: { label: "Style", className: "bg-caution-soft text-caution", Icon: PenIcon },
  expression: { label: "Expression", className: "bg-info-soft text-info", Icon: BookmarkIcon },
};

export function CategoryBadge({ category }: { category: SuggestionCategory }) {
  const { label, className, Icon } = CATEGORY[category];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${className}`}>
      <Icon size={14} />
      {label}
    </span>
  );
}

function SourceLabel({ source }: { source: SuggestionSource }) {
  const local = source === "local";
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted">
      {local ? <DeviceIcon size={13} /> : <SparkIcon size={13} />}
      {local ? "On this device" : "AI check"}
    </span>
  );
}

export function SuggestionCard({
  suggestion,
  active,
  onActivate,
  onDeactivate,
  onFocusCard,
  onApply,
  onDismiss,
}: {
  suggestion: Suggestion;
  active: boolean;
  onActivate: (id: string) => void;
  onDeactivate: (id: string) => void;
  // Keyboard focus also scrolls the text to the range; hovering does not.
  onFocusCard: (id: string) => void;
  onApply: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { id, category, original, replacement, reason, meaningChange } = suggestion;

  const handleBlur = (event: FocusEvent<HTMLLIElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDeactivate(id);
  };

  return (
    <li
      onMouseEnter={() => onActivate(id)}
      onMouseLeave={() => onDeactivate(id)}
      onFocus={() => {
        onActivate(id);
        onFocusCard(id);
      }}
      onBlur={handleBlur}
      className={
        "rounded-tile border bg-card p-3 transition-colors duration-150 " +
        (active ? "border-accent bg-accent-soft/40 ring-2 ring-accent/30" : "border-line")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <CategoryBadge category={category} />
        <SourceLabel source={suggestion.source} />
      </div>

      <p className="mt-2 text-base leading-snug [overflow-wrap:anywhere]">
        <span className="sr-only">Change </span>
        <span className="text-ink-muted line-through decoration-1">{original}</span>
        <span aria-hidden="true" className="mx-1.5 text-ink-muted">
          →
        </span>
        <span className="sr-only"> to </span>
        {replacement === "" ? (
          <span className="font-semibold italic">remove it</span>
        ) : (
          <span className="font-semibold">{replacement}</span>
        )}
      </p>

      <p className="mt-1 text-sm leading-snug text-ink-muted">{reason}</p>

      {meaningChange ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-chip bg-caution-soft px-2 py-1.5 text-xs font-semibold leading-snug text-caution">
          <AlertIcon size={14} className="mt-px shrink-0" />
          <span>Changes meaning. Check it still says what you mean.</span>
        </p>
      ) : null}

      <div className="mt-2.5 flex items-center gap-1">
        <Button size="sm" variant="soft" onClick={() => onApply(id)} aria-label={`Apply: ${original} to ${replacement || "nothing"}`}>
          Apply
        </Button>
        <Button size="sm" variant="quiet" onClick={() => onDismiss(id)} aria-label={`Dismiss: ${original}`}>
          Dismiss
        </Button>
      </div>
    </li>
  );
}
