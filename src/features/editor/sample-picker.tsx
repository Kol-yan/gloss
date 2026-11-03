"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { buttonClasses } from "@/components/ui/button";
import { SAMPLE_TEXTS } from "./sample-texts";

// A disclosure, not a menu: every sample is an ordinary button, so the keyboard
// path is plain Tab and Enter with no arrow-key handling to get wrong.
export function SamplePicker({ onSelect }: { onSelect: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  // Focus goes back to the trigger, because the list is about to leave the DOM.
  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function choose(text: string) {
    close();
    onSelect(text);
  }

  // Escape closes only this list; it must not also close an enclosing dialog.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (open && event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }

  return (
    <div className="flex flex-col items-start gap-2" onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={buttonClasses("secondary", "sm")}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        Try a sample
      </button>
      {open ? (
        <ul id={listId} aria-label="Sample texts" className="flex flex-col items-start gap-1">
          {SAMPLE_TEXTS.map((sample) => (
            <li key={sample.id}>
              <button type="button" className={buttonClasses("quiet", "sm")} onClick={() => choose(sample.text)}>
                {sample.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
