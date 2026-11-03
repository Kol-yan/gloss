"use client";

import type { FocusEvent } from "react";
import { Button } from "@/components/ui/button";
import { VocabularyPronunciation } from "@/components/vocabulary-pronunciation";
import {
  AlertIcon,
  BookmarkIcon,
  DeviceIcon,
  ErrorIcon,
  PenIcon,
  SparkIcon,
} from "@/components/ui/icons";
import type { Suggestion, SuggestionCategory, SuggestionSource } from "@/shared/contracts";
import { describeChange, splitSpaces, spoken } from "./change-view";

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

// Spaces that would be invisible are drawn as a subtle marker, and announced.
function Visible({ text }: { text: string }) {
  return splitSpaces(text).map((part, i) =>
    part.marker ? (
      <span key={i} className="rounded-sm bg-ink/10 px-0.5 font-normal not-italic text-ink-muted">
        <span aria-hidden="true">{part.text}</span>
        <span className="sr-only">{part.text.length === 1 ? " space " : " spaces "}</span>
      </span>
    ) : (
      <span key={i}>{part.text}</span>
    ),
  );
}

export function SuggestionCard({
  suggestion,
  text,
  active,
  onActivate,
  onDeactivate,
  onFocusCard,
  onApply,
  onDismiss,
}: {
  suggestion: Suggestion;
  // The current text, so the card can show the words around the change.
  text: string;
  active: boolean;
  onActivate: (id: string) => void;
  onDeactivate: (id: string) => void;
  // Keyboard focus also scrolls the text to the range; hovering does not.
  onFocusCard: (id: string) => void;
  onApply: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { id, category, original, replacement, reason, meaningChange } = suggestion;
  const change = describeChange(text, suggestion);
  // Harper's message for a spacing or punctuation edit says what the label says.
  const showReason = !(change.label && suggestion.source === "local");
  const summary = change.label ?? `${spoken(original)} to ${spoken(replacement)}`;

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

      {change.label ? (
        <p className="mt-2 text-base font-semibold leading-snug">{change.label}</p>
      ) : (
        <p className="mt-2 text-base leading-snug [overflow-wrap:anywhere]">
          <span className="sr-only">Change </span>
          <span className="text-ink-muted line-through decoration-1">
            <Visible text={original} />
          </span>
          <span aria-hidden="true" className="mx-1.5 text-ink-muted">
            →
          </span>
          <span className="sr-only"> to </span>
          {replacement === "" ? (
            <span className="font-semibold italic">remove it</span>
          ) : (
            <span className="font-semibold">
              <Visible text={replacement} />
            </span>
          )}
        </p>
      )}

      {change.before || change.after ? (
        <p className="mt-1 text-sm leading-snug text-ink-muted [overflow-wrap:anywhere]">
          <span className="sr-only">In your text: </span>
          {change.before}
          {change.removed ? (
            <del className="rounded-sm bg-error-soft px-0.5 text-error decoration-1">
              <Visible text={change.removed} />
            </del>
          ) : null}
          {change.removed && change.added ? <span className="sr-only"> changed to </span> : null}
          {change.added ? (
            <ins className="rounded-sm bg-accent-soft px-0.5 font-semibold text-ink no-underline">
              <Visible text={change.added} />
            </ins>
          ) : null}
          {change.after}
        </p>
      ) : null}

      {category === "expression" ? <VocabularyPronunciation text={replacement} ipa={suggestion.ipa} /> : null}

      {showReason ? <p className="mt-1 text-sm leading-snug text-ink-muted">{reason}</p> : null}

      {meaningChange ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-chip bg-caution-soft px-2 py-1.5 text-xs font-semibold leading-snug text-caution">
          <AlertIcon size={14} className="mt-px shrink-0" />
          <span>Changes meaning. Check it still says what you mean.</span>
        </p>
      ) : null}

      <div className="mt-2.5 flex items-center gap-1">
        <Button size="sm" variant="soft" onClick={() => onApply(id)} aria-label={`Apply: ${summary}`}>
          Apply
        </Button>
        <Button size="sm" variant="quiet" onClick={() => onDismiss(id)} aria-label={`Dismiss: ${change.label ?? spoken(original)}`}>
          Dismiss
        </Button>
      </div>
    </li>
  );
}
