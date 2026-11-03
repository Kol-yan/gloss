"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { VocabularyPronunciation } from "@/components/vocabulary-pronunciation";
import { FAMILIARITY_OPTIONS, type Familiarity, type PracticeOffer } from "./types";

// Shown after an accepted suggestion. Accepting a fix is help, not knowledge,
// so the learner is invited to produce the expression themselves.
export function TryYourselfCard({
  offer,
  status = "idle",
  onStart,
  onSkip,
}: {
  offer: PracticeOffer;
  // "saving" while the expression is being added to the learner's list.
  status?: "idle" | "saving" | "error";
  onStart: (familiarity: Familiarity) => void;
  onSkip: () => void;
}) {
  const [familiarity, setFamiliarity] = useState<Familiarity>("new");
  const groupName = useId();

  return (
    <section aria-label="Try using this yourself" className="rounded-tile border border-accent/40 bg-surface p-3">
      <p className="eyebrow">Try using this yourself</p>
      <p className="mt-1.5 text-xl font-semibold leading-tight [overflow-wrap:anywhere]">{offer.expression}</p>
      <VocabularyPronunciation text={offer.expression} ipa={offer.ipa} />
      <p className="mt-0.5 text-sm leading-snug text-ink-muted">{offer.meaning}</p>

      <fieldset className="mt-3">
        <legend className="text-sm font-semibold">How well do you know it?</legend>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {FAMILIARITY_OPTIONS.map((option) => (
            <label key={option.value} className="cursor-pointer">
              <input
                type="radio"
                name={groupName}
                value={option.value}
                checked={familiarity === option.value}
                onChange={() => setFamiliarity(option.value)}
                className="peer sr-only"
              />
              <span className="inline-flex min-h-9 items-center rounded-full border border-line-strong bg-card px-3 text-sm font-medium leading-tight transition-colors duration-150 hover:bg-accent-soft peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:font-semibold peer-checked:text-accent-strong peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
                {option.label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {status === "error" ? (
        <p role="alert" className="mt-2 text-sm leading-snug text-caution">
          We couldn&apos;t save that just now. Try again.
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-1">
        <Button variant="soft" onClick={() => onStart(familiarity)} pending={status === "saving"}>
          {status === "saving" ? "Saving…" : "Start practice"}
        </Button>
        <Button variant="quiet" onClick={onSkip} disabled={status === "saving"}>
          Skip
        </Button>
      </div>
    </section>
  );
}
