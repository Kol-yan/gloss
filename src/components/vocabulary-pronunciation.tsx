"use client";

import { useId, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { isSingleLexicalWord, sanitizeIpa } from "@/lib/pronunciation";
import {
  getPronunciationState,
  getServerPronunciationState,
  pronounceWord,
  stopOwnedPronunciation,
  subscribePronunciation,
} from "@/features/speech/pronunciation";
import { Button } from "./ui/button";

export function VocabularyPronunciation({ text, ipa }: { text: string | null | undefined; ipa?: string | null }) {
  if (!text || !isSingleLexicalWord(text)) return null;
  const word = text.trim();
  return <WordPronunciation key={word} word={word} ipa={sanitizeIpa(ipa, word)} />;
}

function WordPronunciation({ word, ipa }: { word: string; ipa: string | null }) {
  const [owner] = useState(() => Symbol("pronunciation"));
  const statusId = useId();
  const state = useSyncExternalStore(subscribePronunciation, getPronunciationState, getServerPronunciationState);
  const playing = state.activeOwner === owner;
  const failed = state.errorOwner === owner;
  const blocked = state.microphoneActive || state.availability !== "ready";

  useLayoutEffect(() => () => stopOwnedPronunciation(owner), [owner]);

  const label = state.microphoneActive ? "Audio paused"
    : state.availability === "loading" ? "Loading voice…"
      : state.availability === "unavailable" ? "Audio unavailable" : playing ? "Stop" : "Listen";
  const explanation = state.microphoneActive ? "Pronunciation is paused while the microphone is in use."
    : state.availability === "loading" ? "Loading local English voices from this device."
      : state.availability === "unavailable" ? "No local English voice is available on this device."
        : failed ? "Pronunciation could not play. Try again." : `Uses a local English voice (${state.voiceLanguage}) on this device.`;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {ipa ? (
        <span aria-label={`US IPA: ${ipa}`} className="text-sm leading-snug text-ink-muted"><span className="text-xs">US IPA </span>{ipa}</span>
      ) : (
        <span className="text-xs leading-snug text-ink-muted">IPA unavailable</span>
      )}
      <Button
        variant="quiet"
        size="sm"
        className="h-8 px-1 text-xs"
        disabled={blocked && !playing}
        aria-label={playing ? `Stop pronunciation of ${word}` : `Pronounce ${word}`}
        aria-describedby={statusId}
        aria-pressed={playing}
        onClick={() => playing ? stopOwnedPronunciation(owner) : pronounceWord(word, owner)}
      >
        {label}
      </Button>
      {state.availability === "ready" && state.voiceLanguage && !/^en-US(?:-|$)/i.test(state.voiceLanguage) ? (
        <span className="text-xs leading-snug text-ink-muted">Device voice: {state.voiceLanguage}</span>
      ) : null}
      <span id={statusId} role={failed ? "status" : undefined} className={failed || state.availability === "unavailable" ? "text-xs leading-snug text-ink-muted" : "sr-only"}>
        {explanation}
      </span>
    </div>
  );
}
