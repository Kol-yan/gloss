"use client";

import { useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { MAX_TEXT_LENGTH } from "@/shared/contracts";
import type { Suggestion } from "@/shared/contracts";
import { buildSegments } from "./highlight";

export type WritingSurfaceHandle = {
  focus: () => void;
  // Scrolls the textarea so the highlighted range of a suggestion is visible.
  reveal: (suggestionId: string) => void;
};

// The textarea and its backdrop must lay text out identically, so they share
// every property that affects wrapping.
const TEXT_LAYOUT =
  "m-0 border-0 px-4 py-3 font-sans text-[1.0625rem] leading-7 tracking-normal whitespace-pre-wrap [overflow-wrap:break-word] [word-break:normal]";

export function WritingSurface({
  value,
  suggestions,
  activeId,
  onChange,
  handleRef,
  nearLimit,
}: {
  value: string;
  suggestions: Suggestion[];
  activeId: string | null;
  // `composing` is true while an input method is mid-composition.
  onChange: (value: string, composing: boolean) => void;
  handleRef?: Ref<WritingSurfaceHandle>;
  nearLimit?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);

  const segments = useMemo(() => buildSegments(value, suggestions, activeId), [value, suggestions, activeId]);

  useImperativeHandle(handleRef, () => ({
    focus: () => textareaRef.current?.focus(),
    reveal: (suggestionId) => {
      const textarea = textareaRef.current;
      const backdrop = backdropRef.current;
      if (!textarea || !backdrop) return;
      const mark = Array.from(backdrop.querySelectorAll<HTMLElement>("mark[data-ids]")).find((el) =>
        el.dataset.ids?.split(" ").includes(suggestionId),
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
    const observer = new ResizeObserver(sync);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [value]);

  const showCta = value === "" && !focused;

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-field border border-line-strong bg-card shadow-card focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15">
      <div
        ref={backdropRef}
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 overflow-hidden text-transparent ${TEXT_LAYOUT}`}
      >
        {segments.map((segment, i) =>
          segment.category ? (
            <mark
              key={i}
              className={`hl hl-${segment.category}`}
              data-active={segment.active || undefined}
              data-ids={segment.ids.join(" ")}
            >
              {segment.text}
            </mark>
          ) : (
            <span key={i}>{segment.text}</span>
          ),
        )}
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
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        spellCheck={false}
        autoCorrect="off"
        lang="en"
        maxLength={MAX_TEXT_LENGTH}
        aria-label="Your text"
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
