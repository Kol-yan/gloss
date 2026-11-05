"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BrandLockup, BrandName, BrandedText } from "@/components/brand";
import { VocabularyPronunciation } from "@/components/vocabulary-pronunciation";
import { bootstrapGuestAccess } from "@/features/api/client";
import { ONBOARDING_LEVEL_GROUP_LIST, type OnboardingLevelGroup, type WordCheckAnswer, type WordCheckResponse } from "@/shared/contracts";
import { onboardingClient, type OnboardingClient } from "./client";
import { WordLine } from "./word-line";
import { ToolIcon } from "./tool-icon";
import "./onboarding.css";

export const ONBOARDING_STEPS = ["welcome", "level", "check", "map", "tools", "ready"] as const;
export type OnboardingStep = typeof ONBOARDING_STEPS[number];
const ANSWERS: { value: WordCheckAnswer; label: string }[] = [
  { value: "use", label: "I use it" },
  { value: "know_unused", label: "I know it but don't use it" },
  { value: "not_sure", label: "Not sure" },
  { value: "new", label: "New to me" },
];
const TITLES: Record<OnboardingStep, string> = {
  welcome: "Welcome", level: "Level", check: "Word check", map: "Word map", tools: "Your tools", ready: "All set",
};

export function OnboardingSignIn() {
  const router = useRouter();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    void bootstrapGuestAccess().then((result) => {
      if (!active) return;
      if (result.kind === "ready" || result.kind === "turnstile") router.refresh();
      else setUnavailable(true);
    });
    return () => { active = false; };
  }, [router]);
  return <div className="onboarding-page"><section className="onboarding-window">
    <header className="onb-header"><Link href="/" aria-label="gloss, home"><BrandLockup /></Link></header>
    <div className="onb-content">
      <h1>{unavailable ? "We couldn't start a workspace" : "Getting your workspace ready…"}</h1>
      {unavailable && <p className="onb-lede">Free guest access is unavailable right now. Add your own OpenRouter key in Settings to keep going.</p>}
      {unavailable && <p><Link className="onb-quiet" href="/settings">Open Settings</Link></p>}
    </div>
  </section></div>;
}

function InfoTip({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = pinned || hovered || focused;
  return <span className="onb-tip-anchor" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
    <button type="button" className="onb-info" aria-label={title} aria-expanded={open} aria-describedby={open ? id : undefined}
      onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); setPinned(false); }} onClick={() => setPinned(value => !value)} onKeyDown={e => { if (e.key === "Escape") { setPinned(false); setHovered(false); setFocused(false); } }}>ⓘ</button>
    {open && <span className="onb-tip" id={id} role="tooltip"><strong>{title}</strong>{children}</span>}
  </span>;
}

export function Onboarding({ client = onboardingClient, initialRound = null, initialStep = "welcome" }: {
  client?: OnboardingClient; initialRound?: WordCheckResponse | null; initialStep?: OnboardingStep;
}) {
  const router = useRouter();
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [level, setLevel] = useState<OnboardingLevelGroup>("advanced");
  const [round, setRound] = useState<WordCheckResponse | null>(initialRound);
  const [index, setIndex] = useState(() => Math.max(0, initialRound?.entries.findIndex(entry => entry.answer === null) ?? 0));
  const [answer, setAnswer] = useState<WordCheckAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  const heading = useRef<HTMLDivElement>(null);
  const current = round?.entries[index];
  const selectedAnswer = answer ?? current?.answer ?? null;
  const readyEntries = round?.entries.filter(entry => entry.answer === "know_unused") ?? [];
  const readyWords = readyEntries.slice(0, 3).map(entry => entry.text);
  const hasReady = readyWords.length > 0;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [step]);
  useEffect(() => {
    if (step !== "check" || busy) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || /INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement)?.tagName)) return;
      const choice = ANSWERS[Number(event.key) - 1];
      if (choice) { event.preventDefault(); setAnswer(choice.value); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [step, busy]);

  const go = (next: OnboardingStep) => { setError(null); setStep(next); };
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { await action(); }
    catch { if (mounted.current) setError("We couldn't save that. Please try again."); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const loadCheck = (choice: OnboardingLevelGroup) => run(async () => {
    const chosen = await client.level(choice);
    if (!mounted.current) return;
    if (!chosen.ok) { setError(chosen.message); return; }
    const result = await client.round();
    if (!mounted.current) return;
    if (!result.ok) { setError(result.message); return; }
    setRound(result.data); setAnswer(null);
    const next = result.data.entries.findIndex(entry => entry.answer === null);
    setIndex(Math.max(0, next));
    go(next < 0 ? "map" : "check");
  });
  const nextWord = () => run(async () => {
    if (!current || !selectedAnswer || !round) return;
    const result = await client.answer([{ id: current.id, answer: selectedAnswer }]);
    if (!mounted.current) return;
    if (!result.ok) { setError(result.message); return; }
    const entries = round.entries.map(entry => entry.id === current.id ? { ...entry, answer: selectedAnswer } : entry);
    const next = entries.findIndex(entry => entry.answer === null);
    setRound({ ...round, entries, answered: entries.filter(entry => entry.answer !== null).length, completed: next < 0, level: result.data.level });
    setAnswer(null);
    if (next < 0) go("map"); else { setIndex(next); heading.current?.focus({ preventScroll: true }); }
  });
  const finish = () => run(async () => {
    const result = await client.complete();
    if (!mounted.current) return;
    if (!result.ok) { setError(result.message); return; }
    router.replace("/practice"); router.refresh();
  });
  const next = () => {
    if (step === "welcome") go("level");
    else if (step === "level") void loadCheck(level);
    else if (step === "check") void nextWord();
    else if (step === "map") go("tools");
    else if (step === "tools") go("ready");
    else void finish();
  };
  const back = () => {
    if (step === "level") go("welcome");
    else if (step === "check") {
      setAnswer(null);
      if (index > 0) setIndex(index - 1); else go("level");
    }
    else if (step === "map") { setIndex(Math.max(0, (round?.entries.length ?? 1) - 1)); setAnswer(null); go("check"); }
    else if (step === "tools") go("map");
    else if (step === "ready") go("tools");
  };

  return <div className="onboarding-page">
    <section className="onboarding-window" aria-label="Get started with gloss" data-step={step} aria-busy={busy}>
      <header className="onb-header"><Link href="/" aria-label="gloss, home"><BrandLockup /></Link><span className="onb-step-label">{TITLES[step]}</span></header>
      <div className="onb-content" ref={heading} tabIndex={-1}>
        {step === "welcome" && <><h1>Nice to meet you.</h1><p className="onb-lede is-ink">Turn the words you know into words you use.</p><WordLine mode="welcome" /></>}
        {step === "level" && <><h1>What&apos;s your English level?</h1><p className="onb-lede">We&apos;ll pick words for a short check.</p>
          <fieldset className="onb-list"><legend className="sr-only">Your English level</legend>{ONBOARDING_LEVEL_GROUP_LIST.filter(option => option.group !== "unsure").map(option => <label className={`onb-row ${level === option.group ? "is-selected" : ""}`} key={option.group}>
            <input type="radio" name="level" value={option.group} checked={level === option.group} onChange={() => setLevel(option.group)} disabled={busy} /><span className="onb-radio" /><span className="onb-text">{option.label}</span><span className="onb-code">{option.rangeLabel}</span>
          </label>)}</fieldset>
          <button className="onb-quiet" type="button" disabled={busy} onClick={() => { setLevel("unsure"); void loadCheck("unsure"); }}>Not sure? The word check will tell.</button>
        </>}
        {step === "check" && current && round && <>
          <h1 className="sr-only">Word check</h1><div className="check-progress" role="progressbar" aria-label="Word check progress" aria-valuemin={0} aria-valuemax={round.roundSize} aria-valuenow={round.answered}>
            {round.entries.map((entry, i) => <span key={entry.id} className={`check-seg ${entry.answer ? "is-done" : i === index ? "is-current" : ""}`} />)}
          </div><p className="check-ask">Do you use this word?<InfoTip title="Why it matters">Your answers show your level and which words we start with.</InfoTip><span className="check-count">{index + 1}/{round.roundSize}</span></p>
          <div className="check-hero"><span className="check-word">{current.text}</span><VocabularyPronunciation text={current.text} ipa={current.ipa} /></div>
          <p className="check-example">{current.example ?? current.definition}</p>
          <fieldset className="onb-list"><legend className="sr-only">Do you use this word?</legend>{ANSWERS.map((option, i) => <label key={option.value} className={`onb-row ${selectedAnswer === option.value ? "is-selected" : ""}`}>
            <input type="radio" name="word-answer" value={option.value} checked={selectedAnswer === option.value} onChange={() => setAnswer(option.value)} disabled={busy} /><span className="onb-key" aria-hidden="true">{i + 1}</span><span className="onb-text">{option.label}</span>
          </label>)}</fieldset>
        </>}
        {step === "map" && <><h1>Your starting words are ready</h1><WordLine mode="map" words={readyWords} />
          {hasReady ? <p className="onb-legend"><span className="legend-line" aria-hidden="true" /><span><b>On the line:</b> words you know but don&apos;t use yet. We start with them.<InfoTip title="Why these first?">You already understand them, so a little practice moves them into use.</InfoTip></span></p>
            : <p className="onb-legend">Your answers give us a starting point. We&apos;ll find more words to practice as you write.</p>}
        </>}
        {step === "tools" && <><h1>We prepared a few tools for you</h1><div className="onb-tools">
          <section className="onb-tool"><div className="tool-head"><span className="tool-tile"><ToolIcon name="browser" size={24} /></span><h2>Browser extension</h2></div>
            <ul><li><ToolIcon name="check" />Writing checks on every site</li><li><ToolIcon name="cursor" /><span>Right-click a word: <strong>Add to <BrandName /></strong></span></li><li><ToolIcon name="highlighter" /><strong>Highlight my words</strong></li></ul>
            <a href="https://github.com/Kol-yan/gloss#browser-extension" target="_blank" rel="noreferrer">Add to Chrome →</a></section>
          <span className="tools-divider" aria-hidden="true" />
          <section className="onb-tool"><div className="tool-head"><span className="tool-tile"><ToolIcon name="laptop" size={24} /></span><h2>Desktop app</h2></div>
            <ul><li><ToolIcon name="check" />Checks in every app</li><li><ToolIcon name="mic" />Dictation, tidied up</li></ul>
            <a href="https://github.com/Kol-yan/gloss#desktop-app" target="_blank" rel="noreferrer">Download for Mac →</a></section>
        </div></>}
        {step === "ready" && <><h1>{hasReady ? "Your first practice is ready" : "You're all set"}</h1><p className="onb-lede ready-lede">{readyEntries.length >= 8 ? "8 words, about 6 minutes. We start with the words on the line." : hasReady ? "We start with the words on the line." : "Add words while you write, then come back to practice."}</p><WordLine mode="ready" words={readyWords} /></>}
      </div>
      {error && <p className="onb-error" role="alert"><BrandedText text={error} /></p>}
      <footer className="onb-actions">
        {step !== "welcome" && <button className="onb-back" type="button" onClick={back} disabled={busy}>{step === "ready" ? "Install tools" : "Back"}</button>}
        <button className="onb-next" type="button" onClick={next} disabled={busy || (step === "check" && !selectedAnswer)}>{busy ? "Saving…" : step === "welcome" ? "Get started" : step === "ready" ? hasReady ? "Start first practice" : "Open practice" : step === "check" ? "Next" : "Continue"}</button>
      </footer>
    </section>
  </div>;
}
