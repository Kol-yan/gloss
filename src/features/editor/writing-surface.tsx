"use client";

import { useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { MAX_TEXT_LENGTH } from "@/shared/contracts";
import type { Suggestion } from "@/shared/contracts";
import { buildSegments } from "./highlight";
import type { Box } from "./popover-state";
import type { SentenceFlag } from "./sentence-detect";

export type WritingSurfaceHandle = {
  // Puts the caret at `caret` when given, otherwise leaves it where it was.
  focus: (caret?: number) => void;
  // The caret position, or null while a range is selected.
  caret: () => number | null;
  // Scrolls the textarea so the highlighted range of a suggestion or flagged sentence is visible.
  reveal: (id: string) => void;
  // Where a suggestion's underline is on screen, relative to `relativeTo`. Null
  // when it is scrolled out of the visible part of the text.
  anchorOf: (id: string, relativeTo: Element) => Box | null;
};

// Pixels above and below an underline that still count as clicking it; the text
// line is taller than the underlined glyphs.
const HIT_SLACK = 4;

// The textarea and its backdrop must lay text out identically, so they share
// every property that affects wrapping.
const TEXT_LAYOUT =
  "m-0 border-0 px-4 py-3 font-sans text-[1.0625rem] leading-7 tracking-normal whitespace-pre-wrap [overflow-wrap:break-word] [word-break:normal]";

export function WritingSurface({
  value,
  suggestions,
  flags = [],
  activeId,
  activeFlagId = null,
  onChange,
  onTextClick,
  onFlagClick,
  onEditorKeyDown,
  onLayoutChange,
  handleRef,
  nearLimit,
}: {
  value: string;
  suggestions: Suggestion[];
  // Sentences the detector flagged, drawn under the whole sentence.
  flags?: SentenceFlag[];
  activeId: string | null;
  activeFlagId?: string | null;
  // `composing` is true while an input method is mid-composition.
  onChange: (value: string, composing: boolean) => void;
  // A click that placed the caret (no selection) reports the suggestions
  // underlined under the pointer; the list is empty when the click hit no underline.
  onTextClick?: (ids: string[]) => void;
  onFlagClick?: (flagId: string) => void;
  onEditorKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  // The text scrolled or the field was resized, so anything placed next to a word has to follow.
  onLayoutChange?: () => void;
  handleRef?: Ref<WritingSurfaceHandle>;
  nearLimit?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);

  const segments = useMemo(
    () => buildSegments(value, suggestions, activeId, flags, activeFlagId),
    [value, suggestions, activeId, flags, activeFlagId],
  );

  // The underlined runs of the backdrop that belong to a suggestion.
  const marksFor = (id: string) =>
    Array.from(backdropRef.current?.querySelectorAll<HTMLElement>("[data-ids]") ?? []).filter((el) =>
      el.dataset.ids?.split(" ").includes(id),
    );

  // The suggestions underlined at a point of the screen. The backdrop does not
  // take pointer events, so the text is hit-tested by the boxes of its runs.
  const idsAt = (x: number, y: number): string[] => {
    for (const mark of backdropRef.current?.querySelectorAll<HTMLElement>("[data-ids]") ?? []) {
      for (const rect of mark.getClientRects()) {
        if (x >= rect.left && x <= rect.right && y >= rect.top - HIT_SLACK && y <= rect.bottom + HIT_SLACK) {
          return mark.dataset.ids?.split(" ").filter(Boolean) ?? [];
        }
      }
    }
    return [];
  };

  const flagAt = (x: number, y: number): string | null => {
    for (const el of backdropRef.current?.querySelectorAll<HTMLElement>("[data-flag-id]") ?? []) {
      for (const rect of el.getClientRects()) {
        if (x >= rect.left && x <= rect.right && y >= rect.top - HIT_SLACK && y <= rect.bottom + HIT_SLACK) {
          return el.dataset.flagId ?? null;
        }
      }
    }
    return null;
  };

  useImperativeHandle(handleRef, () => ({
    focus: (caret) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      if (caret !== undefined) textarea.setSelectionRange(caret, caret);
    },
    caret: () => {
      const textarea = textareaRef.current;
      return textarea && textarea.selectionStart === textarea.selectionEnd ? textarea.selectionStart : null;
    },
    anchorOf: (id, relativeTo) => {
      const textarea = textareaRef.current;
      if (!textarea) return null;
      const view = textarea.getBoundingClientRect();
      const origin = relativeTo.getBoundingClientRect();
      // Runs that wrap onto several lines have several boxes; the first one in view wins.
      for (const mark of marksFor(id)) {
        for (const rect of mark.getClientRects()) {
          if (rect.bottom > view.top && rect.top < view.bottom) {
            return {
              left: rect.left - origin.left,
              top: rect.top - origin.top,
              right: rect.right - origin.left,
              bottom: rect.bottom - origin.top,
            };
          }
        }
      }
      return null;
    },
    reveal: (id) => {
      const textarea = textareaRef.current;
      const backdrop = backdropRef.current;
      if (!textarea || !backdrop) return;
      const mark = Array.from(backdrop.querySelectorAll<HTMLElement>("[data-ids], [data-flag-id]")).find(
        (el) => el.dataset.ids?.split(" ").includes(id) || el.dataset.flagId === id,
      );
      if (!mark) return;
      const top = mark.offsetTop;
      const bottom = top + mark.offsetHeight;
      if (top < textarea.scrollTop || bottom > textarea.scrollTop + textarea.clientHeight) {
        textarea.scrollTop = Math.max(0, top - textarea.clientHeight / 3);
        backdrop.scrollTop = textarea.scrollTop;
      }
    },
  }));

  // Keep the backdrop as wide as the textarea's text area (the scrollbar takes
  // space from the textarea only) and at the same scroll position.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const backdrop = backdropRef.current;
    if (!textarea || !backdrop) return;
    const sync = () => {
      backdrop.style.right = `${textarea.offsetWidth - textarea.clientWidth}px`;
      backdrop.scrollTop = textarea.scrollTop;
    };
    sync();
    const observer = new ResizeObserver(() => {
      sync();
      onLayoutChange?.();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [value, onLayoutChange]);

  // A collapsed selection after a click means the learner tapped a spot, not that they are selecting text.
  const handleClick = (event: MouseEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget;
    if (textarea.selectionStart !== textarea.selectionEnd) return;
    const ids = idsAt(event.clientX, event.clientY);
    if (ids.length > 0) {
      onTextClick?.(ids);
      return;
    }
    const fid = flagAt(event.clientX, event.clientY);
    if (fid) {
      onFlagClick?.(fid);
      return;
    }
    onTextClick?.([]);
  };

  // The pointer shows that an underline can be clicked.
  const handleMouseMove = (event: MouseEvent<HTMLTextAreaElement>) => {
    if (!onTextClick) return;
    event.currentTarget.style.cursor = idsAt(event.clientX, event.clientY).length > 0 ? "pointer" : "";
  };

  const showCta = value === "" && !focused;

  return (
    <div data-writing-surface className="relative min-h-0 flex-1 overflow-hidden rounded-field border border-line-strong bg-card shadow-card focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15">
      <div
        ref={backdropRef}
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 overflow-hidden text-transparent ${TEXT_LAYOUT}`}
      >
        {segments.map((segment, i) => {
          const flagClass = segment.flag ? ` sflag sflag-${segment.flag}` : "";
          const flagProps = segment.flagId
            ? { "data-flag-id": segment.flagId, "data-flag-active": segment.flagActive || undefined }
            : {};
          return segment.category ? (
            <mark
              key={i}
              className={`hl hl-${segment.category}${flagClass}`}
              data-active={segment.active || undefined}
              data-ids={segment.ids.join(" ")}
              {...flagProps}
            >
              {segment.text}
            </mark>
          ) : (
            <span key={i} className={flagClass.trim() || undefined} {...flagProps}>
              {segment.text}
            </span>
          );
        })}
        {/* A trailing newline keeps the last empty line as tall as in the textarea. */}
        {"\n"}
      </div>

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value, (event.nativeEvent as InputEvent).isComposing === true)}
        onCompositionEnd={(event) => onChange(event.currentTarget.value, false)}
        onScroll={(event) => {
          if (backdropRef.current) backdropRef.current.scrollTop = event.currentTarget.scrollTop;
          onLayoutChange?.();
        }}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onKeyDown={onEditorKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        spellCheck={false}
        autoCorrect="off"
        lang="en"
        maxLength={MAX_TEXT_LENGTH}
        aria-label="Your text"
        aria-keyshortcuts="Alt+Enter"
        aria-describedby={nearLimit ? "editor-limit" : undefined}
        placeholder="Type or paste your English here."
        className={`absolute inset-0 block h-full w-full resize-none overflow-y-auto bg-transparent text-ink caret-accent outline-none placeholder:text-ink-muted ${TEXT_LAYOUT}`}
      />

      {showCta ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card px-6 text-center">
          <p className="eyebrow">Editor</p>
          <h2 className="text-balance text-2xl font-semibold leading-tight tracking-tight">Check your English writing</h2>
          <p className="max-w-sm text-pretty text-base text-ink-muted">
            Paste or write a few sentences. Suggestions appear next to your text.
          </p>
          <Button variant="primary" className="pointer-events-auto mt-1" onClick={() => textareaRef.current?.focus()}>
            Start writing
          </Button>
        </div>
      ) : null}
    </div>
  );
}
