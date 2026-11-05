"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BrandName } from "@/components/brand";
import { AccessUnavailable, DemoSpentNotice } from "@/components/invite-required";
import { VocabularyPronunciation } from "@/components/vocabulary-pronunciation";
import { Button } from "@/components/ui/button";
import {
  getMe,
  isAiOff,
  isQuota,
  isUnauthorized,
  newRequestId,
  type ApiFailure,
  type ApiResult,
} from "@/features/api/client";
import { useAccess } from "@/features/api/use-access";
import { useLoad } from "@/features/api/use-load";
import {
  type PracticeSessionAnswerView,
  type PracticeReaction,
  type PracticeSessionExercise,
  type PracticeSessionFinishResponse,
  type PracticeSessionReadiness,
} from "@/shared/contracts";
import {
  createFixturePracticeClient,
  fixtureReactionLabels,
  fixtureSessionId,
  practiceFixtureExercises,
  type PracticeFixtureName,
} from "@/lib/practice-session-fixtures";
import { livePracticeSessionClient, type PracticeSessionClient } from "@/lib/practice-session-client";
import "./practice-session.css";

const styles = {
  accessScreen: "practice-session-access-screen",
  answerBody: "practice-session-answer-body",
  answerCorrect: "practice-session-answer-correct",
  answerScreen: "practice-session-answer-screen",
  answerWrong: "practice-session-answer-wrong",
  band: "practice-session-band",
  endActions: "practice-session-end-actions",
  endLine: "practice-session-end-line",
  endScreen: "practice-session-end-screen",
  endTitle: "practice-session-end-title",
  errorActions: "practice-session-error-actions",
  errorScreen: "practice-session-error-screen",
  example: "practice-session-example",
  eyebrow: "practice-session-eyebrow",
  footer: "practice-session-footer",
  footerAnswer: "practice-session-footer-answer",
  hero: "practice-session-hero",
  hintText: "practice-session-hint-text",
  promptDisclosure: "practice-session-prompt-disclosure",
  history: "practice-session-history",
  historyDot: "practice-session-history-dot",
  historyList: "practice-session-history-list",
  instruction: "practice-session-instruction",
  invite: "practice-session-invite",
  loadingContent: "practice-session-loading-content",
  loadingLine: "practice-session-loading-line",
  meaning: "practice-session-meaning",
  notice: "practice-session-notice",
  option: "practice-session-option",
  optionGrid: "practice-session-option-grid",
  optionNumber: "practice-session-option-number",
  optionSelected: "practice-session-option-selected",
  path: "practice-session-path",
  pathBlock: "practice-session-path-block",
  pathDot: "practice-session-path-dot",
  primaryButton: "practice-session-primary-button",
  progressFill: "practice-session-progress-fill",
  progressIndeterminate: "practice-session-progress-indeterminate",
  progressTrack: "practice-session-progress-track",
  pronunciation: "practice-session-pronunciation",
  quietButton: "practice-session-quiet-button",
  quietLink: "practice-session-quiet-link",
  reaction: "practice-session-reaction",
  reactionSelected: "practice-session-reaction-selected",
  reactions: "practice-session-reactions",
  recallField: "practice-session-recall-field",
  resultLabel: "practice-session-result-label",
  returns: "practice-session-returns",
  secondaryActions: "practice-session-secondary-actions",
  segment: "practice-session-segment",
  segmentCurrent: "practice-session-segment-current",
  segmentDone: "practice-session-segment-done",
  segmentedProgress: "practice-session-segmented-progress",
  sessionBody: "practice-session-session-body",
  sessionForm: "practice-session-session-form",
  denseContent: "practice-session-dense-content",
  srOnly: "practice-session-sr-only",
  viewport: "practice-session-viewport",
  window: "practice-session-window",
  word: "practice-session-word",
  wordRow: "practice-session-word-row",
} as const;

type Screen =
  | { name: "boot" }
  | { name: "preparing" }
  | { name: "loading-next" }
  | { name: "waiting" }
  | { name: "exercise" }
  | { name: "answer" }
  | { name: "end" }
  | { name: "invite" }
  | { name: "error"; title: ReactNode; detail: ReactNode; retry: "prepare" | "next" | "answer" | "finish" };

type RetryAction = "prepare" | "next" | "answer" | "finish";
type ActiveRun = { controller: AbortController; generation: number };

type InitialState = {
  screen: Screen;
  readiness: PracticeSessionReadiness;
  sessionId: string | null;
  exercise: PracticeSessionExercise | null;
  answer: PracticeSessionAnswerView | null;
  summary: PracticeSessionFinishResponse | null;
  completed: number;
  selected: number | null;
};

const REACTIONS: { key: PracticeReaction; icon: string }[] = [
  { key: "already_know", icon: "✓" },
  { key: "too_easy", icon: "↗" },
  { key: "not_relevant", icon: "○" },
  { key: "too_hard", icon: "!" },
];

function blankReadiness(): PracticeSessionReadiness {
  return { sessionId: fixtureSessionId, ready: 0, total: 8, status: "preparing", canStart: false };
}

function answerForFixture(correct: boolean): PracticeSessionAnswerView {
  const item = practiceFixtureExercises[3];
  return {
    exerciseId: item.exerciseId,
    correct,
    word: item.word,
    frequency: item.frequency,
    ipa: item.ipa,
    meaning: item.meaning,
    example: item.example,
    comesBackText: correct ? "in 2 days" : "tomorrow",
    allowedReactions: REACTIONS.map(({ key }) => key),
    reaction: null,
  };
}

function initialState(fixture?: PracticeFixtureName): InitialState {
  const ready = { sessionId: fixtureSessionId, ready: 8, total: 8, status: "ready" as const, canStart: true };
  const exerciseIndex: Partial<Record<PracticeFixtureName, number>> = {
    recognise: 0,
    meaning: 1,
    gap: 2,
    recall: 3,
  };

  if (fixture === "preparing") {
    return {
      screen: { name: "preparing" },
      readiness: { sessionId: fixtureSessionId, ready: 2, total: 8, status: "preparing", canStart: false },
      sessionId: fixtureSessionId,
      exercise: null,
      answer: null,
      summary: null,
      completed: 0,
      selected: null,
    };
  }

  if (fixture && exerciseIndex[fixture] !== undefined) {
    const completed = exerciseIndex[fixture] ?? 0;
    return {
      screen: { name: "exercise" },
      readiness: ready,
      sessionId: fixtureSessionId,
      exercise: practiceFixtureExercises[completed],
      answer: null,
      summary: null,
      completed,
      selected: null,
    };
  }

  if (fixture === "correct" || fixture === "wrong") {
    return {
      screen: { name: "answer" },
      readiness: ready,
      sessionId: fixtureSessionId,
      exercise: practiceFixtureExercises[3],
      answer: answerForFixture(fixture === "correct"),
      summary: null,
      completed: 3,
      selected: null,
    };
  }

  if (fixture === "end") {
    return {
      screen: { name: "end" },
      readiness: ready,
      sessionId: fixtureSessionId,
      exercise: null,
      answer: null,
      summary: {
        sessionId: fixtureSessionId,
        summary: "8 words in 6 minutes.",
        correct: 6,
        answered: 8,
        total: 8,
        durationSeconds: 360,
        durationMinutes: 6,
      },
      completed: 8,
      selected: null,
    };
  }

  if (fixture === "waiting") {
    return {
      screen: { name: "waiting" },
      readiness: { sessionId: fixtureSessionId, ready: 3, total: 8, status: "preparing", canStart: true },
      sessionId: fixtureSessionId,
      exercise: null,
      answer: null,
      summary: null,
      completed: 3,
      selected: null,
    };
  }

  if (fixture === "error") {
    return {
      screen: { name: "error", title: "Practice isn't ready.", detail: "Try again in a moment.", retry: "prepare" },
      readiness: blankReadiness(),
      sessionId: null,
      exercise: null,
      answer: null,
      summary: null,
      completed: 0,
      selected: null,
    };
  }

  return {
    screen: { name: "boot" },
    readiness: blankReadiness(),
    sessionId: null,
    exercise: null,
    answer: null,
    summary: null,
    completed: 0,
    selected: null,
  };
}

function friendlyFailure(failure: ApiFailure, action: RetryAction): { title: ReactNode; detail: ReactNode } {
  if (isQuota(failure) || failure.code === "budget_exhausted") {
    return {
      title: "The free demo is used up.",
      detail: <>Add your own OpenRouter key in <Link href="/settings" className="font-semibold underline underline-offset-2">Settings</Link> to keep going.</>,
    };
  }
  if (isAiOff(failure)) return { title: "Practice is paused right now.", detail: "Please come back later." };
  if (failure.code === "network") return { title: <>{"We couldn't reach "}<BrandName />.</>, detail: "Check your connection, then try again." };
  if (failure.code === "not_found") return { title: "This practice has ended.", detail: "Start a new round." };
  if (action === "answer") return { title: "We couldn't check that answer.", detail: "Please try again." };
  if (action === "next") return { title: "The next exercise isn't ready.", detail: "Try again in a moment." };
  if (action === "finish") return { title: "We couldn't finish this session.", detail: "Try again in a moment." };
  return { title: "We couldn't prepare practice.", detail: "Try again in a moment." };
}

function frequencyHelp(band: PracticeSessionAnswerView["frequency"]): string {
  if (band === "core") return "Core words are essential and appear very often.";
  if (band === "common") return "Common words appear often in everyday English.";
  if (band === "uncommon") return "Uncommon words appear less often.";
  return "Rare words appear infrequently.";
}

function getBandLabel(band: PracticeSessionAnswerView["frequency"]): string {
  return band[0].toUpperCase() + band.slice(1);
}

function isApiFailure<T>(result: ApiResult<T>): result is ApiFailure {
  return !result.ok;
}

export interface PracticeSessionProps {
  client?: PracticeSessionClient;
  initialFixture?: PracticeFixtureName;
}

export function PracticeSession(props: PracticeSessionProps) {
  if (props.initialFixture || props.client) return <PracticeSessionBody {...props} />;
  return <PracticeSessionAccess />;
}

export function PracticeSessionLoading({ label }: { label: string }) {
  return (
    <div className={styles.viewport}>
      <section className={styles.window} aria-label="Practice session">
        <div className={styles.loadingContent} role="status">
          <div className={styles.progressTrack} aria-hidden="true">
            <span className={styles.progressIndeterminate} />
          </div>
          <p className={styles.loadingLine}>{label}</p>
        </div>
      </section>
    </div>
  );
}

function PracticeSessionAccess() {
  const access = useAccess();
  const { result, reload } = useLoad(getMe);

  if (!result) return <PracticeSessionLoading label="Checking your access." />;

  if (isApiFailure(result)) {
    if (isUnauthorized(result)) return <AccessUnavailable />;
    return (
      <div className={styles.viewport}>
        <section className={styles.window} aria-label="Practice session">
          <div className={styles.errorScreen}>
            <h1 className={styles.endTitle}>We couldn&apos;t check access.</h1>
            <p className={styles.endLine}>Try again in a moment.</p>
            <footer className={styles.errorActions}>
              <Link className={styles.quietLink} href="/editor">Back to writing</Link>
              <Button className={styles.primaryButton} onClick={reload}>Try again</Button>
            </footer>
          </div>
        </section>
      </div>
    );
  }

  const identity = `${result.data.learner.id}:${result.data.accessMode}:${access.sessionRevision}`;
  return (
    <div className="relative h-full">
      {!result.data.aiEnabled && result.data.accessMode === "hosted" ? (
        <div className="absolute left-4 right-24 top-2 z-40"><DemoSpentNotice className="mx-auto max-w-xl" /></div>
      ) : null}
      <PracticeSessionBody key={identity} client={livePracticeSessionClient} />
    </div>
  );
}

function PracticeSessionBody({ client, initialFixture }: PracticeSessionProps) {
  const start = useMemo(() => initialState(initialFixture), [initialFixture]);
  const sessionClient = useMemo(
    () => client ?? (initialFixture ? createFixturePracticeClient(initialFixture) : livePracticeSessionClient),
    [client, initialFixture],
  );
  const fixedFixture = Boolean(initialFixture && initialFixture !== "flow");
  const [screen, setScreenState] = useState<Screen>(start.screen);
  const [readiness, setReadinessState] = useState(start.readiness);
  const [sessionId, setSessionId] = useState<string | null>(start.sessionId);
  const [exercise, setExercise] = useState<PracticeSessionExercise | null>(start.exercise);
  const [answer, setAnswer] = useState<PracticeSessionAnswerView | null>(start.answer);
  const [summary, setSummary] = useState<PracticeSessionFinishResponse | null>(start.summary);
  const [completed, setCompleted] = useState(start.completed);
  const [selected, setSelected] = useState<number | null>(start.selected);
  const [typedAnswer, setTypedAnswer] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [usedHint, setUsedHint] = useState(false);
  const [hintPending, setHintPending] = useState(false);
  const [notice, setNotice] = useState<ReactNode | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const stageRef = useRef<Screen>(start.screen);
  const readinessRef = useRef<PracticeSessionReadiness>(start.readiness);
  const activeRunRef = useRef<ActiveRun | null>(null);
  const generationRef = useRef(0);
  const firstStartRef = useRef(false);
  const pollTimedOutRef = useRef(false);
  const choiceRefs = useRef<Array<HTMLInputElement | null>>([]);
  const choiceGroupId = useId();
  const recallId = useId();
  const pathDescriptionId = useId();

  const setScreen = (next: Screen) => {
    stageRef.current = next;
    setScreenState(next);
  };
  const setReadiness = (next: PracticeSessionReadiness) => {
    readinessRef.current = next;
    setReadinessState(next);
  };

  const withLock = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const isCurrentRun = (run: ActiveRun | null) =>
    mountedRef.current && (!run || (
      activeRunRef.current === run
      && run.generation === generationRef.current
      && !run.controller.signal.aborted
    ));

  const setFailure = (failure: ApiFailure, action: RetryAction) => {
    if (isUnauthorized(failure)) {
      void getMe();
      setScreen({ name: "invite" });
      return;
    }
    const copy = friendlyFailure(failure, action);
    setScreen({ name: "error", ...copy, retry: action });
  };

  const finishSession = async (id: string, run = activeRunRef.current) => {
    setScreen({ name: "loading-next" });
    const result = await sessionClient.finish(id, run ? { signal: run.controller.signal } : undefined);
    if (!isCurrentRun(run)) return;
    if (isApiFailure(result)) {
      setFailure(result, "finish");
      return;
    }
    setSummary(result.data);
    setScreen({ name: "end" });
  };

  const loadNext = async (id: string, run = activeRunRef.current) => {
    setNotice(null);
    setScreen({ name: "loading-next" });
    const result = await sessionClient.next(id, run ? { signal: run.controller.signal } : undefined);
    if (!isCurrentRun(run)) return;
    if (isApiFailure(result)) {
      setFailure(result, "next");
      return;
    }
    if (result.data.status === "ready" && result.data.exercise) {
      setExercise(result.data.exercise);
      setAnswer(null);
      setSelected(null);
      setTypedAnswer("");
      setHint(null);
      setUsedHint(false);
      setScreen({ name: "exercise" });
    } else if (result.data.status === "waiting") {
      setExercise(null);
      if (pollTimedOutRef.current || readinessRef.current.status === "failed") {
        setScreen({
          name: "error",
          title: "More exercises aren't ready.",
          detail: "Try a fresh round in a moment.",
          retry: "prepare",
        });
      } else {
        setScreen({ name: "waiting" });
      }
    } else {
      setExercise(null);
      await finishSession(id);
    }
  };

  const startSession = async () => {
    setNotice(null);
    await withLock(async () => {
      activeRunRef.current?.controller.abort();
      const run: ActiveRun = {
        controller: new AbortController(),
        generation: ++generationRef.current,
      };
      activeRunRef.current = run;
      pollTimedOutRef.current = false;
      setScreen({ name: "boot" });
      setSessionId(null);
      setExercise(null);
      setAnswer(null);
      setSummary(null);
      setCompleted(0);
      setSelected(null);
      setTypedAnswer("");
      setHint(null);
      setUsedHint(false);
      setHintPending(false);
      const result = await sessionClient.prepare(
        { requestId: newRequestId(), size: 8 },
        { signal: run.controller.signal },
      );
      if (!isCurrentRun(run)) return;
      if (isApiFailure(result)) {
        setFailure(result, "prepare");
        return;
      }
      const prepared = result.data;
      setReadiness(prepared);
      setSessionId(prepared.sessionId);
      if (prepared.status === "failed") {
        setScreen({ name: "error", title: "Practice couldn't be prepared.", detail: "Try again in a moment.", retry: "prepare" });
        return;
      }
      if (prepared.total === 0 || prepared.status === "empty") {
        await finishSession(prepared.sessionId, run);
      } else if (prepared.canStart) {
        await loadNext(prepared.sessionId, run);
      } else {
        setScreen({ name: "preparing" });
      }
    });
  };

  const submitAnswer = async (dontKnow = false) => {
    if (!sessionId || !exercise) return;
    const run = activeRunRef.current;
    const value = dontKnow ? "" : exercise.rung === 4
      ? typedAnswer.trim()
      : exercise.options?.[selected ?? -1] ?? "";
    if (!dontKnow && !value) return;

    await withLock(async () => {
      setNotice(null);
      const result = await sessionClient.answer(sessionId, {
        exerciseId: exercise.exerciseId,
        answer: value,
        usedHint,
        ...(dontKnow ? { dontKnow: true } : {}),
      }, run ? { signal: run.controller.signal } : undefined);
      if (!isCurrentRun(run)) return;
      if (isApiFailure(result)) {
        if (isUnauthorized(result)) { void getMe(); setScreen({ name: "invite" }); }
        else setNotice(friendlyFailure(result, "answer").title);
        return;
      }
      setAnswer(result.data.answer);
      setScreen({ name: "answer" });
    });
  };

  const requestHint = async () => {
    if (!sessionId || !exercise || hint || usedHint) return;
    await withLock(async () => {
      setHintPending(true);
      setNotice(null);
      const run = activeRunRef.current;
      const result = await sessionClient.hint(
        sessionId,
        { exerciseId: exercise.exerciseId },
        run ? { signal: run.controller.signal } : undefined,
      );
      if (!isCurrentRun(run)) return;
      if (isApiFailure(result)) {
        if (isUnauthorized(result)) { void getMe(); setScreen({ name: "invite" }); }
        else setNotice("We couldn't get a hint. Your answer is still yours to choose.");
        setHintPending(false);
        return;
      }
      setHint(result.data.hint);
      setUsedHint(true);
      setHintPending(false);
    });
  };

  const saveReaction = async (reaction: PracticeReaction) => {
    if (!sessionId || !answer || busy || answer.reaction) return;
    await withLock(async () => {
      setNotice(null);
      const run = activeRunRef.current;
      const result = await sessionClient.reaction(
        sessionId,
        { exerciseId: answer.exerciseId, reaction },
        run ? { signal: run.controller.signal } : undefined,
      );
      if (!isCurrentRun(run)) return;
      if (isApiFailure(result)) {
        if (isUnauthorized(result)) { void getMe(); setScreen({ name: "invite" }); }
        else setNotice("We couldn't save that response. You can keep going.");
        return;
      }
      setAnswer(result.data.answer);
    });
  };

  const retry = () => {
    if (screen.name !== "error") return;
    if (screen.retry === "prepare") void startSession();
    else if (screen.retry === "finish" && sessionId) void withLock(() => finishSession(sessionId));
    else if (screen.retry === "next" && sessionId) void withLock(() => loadNext(sessionId));
    else if (screen.retry === "answer") void submitAnswer();
  };

  const continueAnswer = async () => {
    if (!sessionId) return;
    await withLock(async () => {
      setCompleted((value) => Math.min(value + 1, readinessRef.current.total));
      await loadNext(sessionId);
    });
  };

  useEffect(() => {
    mountedRef.current = true;
    if (!fixedFixture && screen.name === "boot" && !firstStartRef.current) {
      firstStartRef.current = true;
      void startSession();
    }
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (!mountedRef.current) activeRunRef.current?.controller.abort();
      });
    };
    // A session starts once per mounted page. Retries always use a fresh id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (fixedFixture || !sessionId) return;
    const controller = new AbortController();
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = activeRunRef.current;
    const shouldKeepPolling = () => {
      const latest = readinessRef.current;
      return latest.status !== "failed" && latest.status !== "empty" && latest.status !== "finished"
        && (latest.status === "preparing" || latest.ready < latest.total);
    };

    const poll = async () => {
      if (!mountedRef.current || controller.signal.aborted || !shouldKeepPolling()) return;
      if (attempts >= 60) {
        const name = stageRef.current.name;
        if (name === "preparing" || name === "waiting") {
          pollTimedOutRef.current = true;
          setScreen({ name: "error", title: "Practice is taking too long.", detail: "Try a fresh round in a moment.", retry: "prepare" });
        } else {
          pollTimedOutRef.current = true;
          setNotice("More exercises are still preparing. Your answers are saved.");
        }
        return;
      }
      attempts += 1;
      const result = await sessionClient.readiness(sessionId, { signal: controller.signal });
      if (!isCurrentRun(run) || controller.signal.aborted) return;
      if (isApiFailure(result)) {
        if (isUnauthorized(result)) {
          void getMe();
          setScreen({ name: "invite" });
          return;
        }
        setNotice("We couldn't refresh preparation. We'll keep checking.");
      } else {
        setReadiness(result.data);
        if (result.data.status === "empty" && stageRef.current.name === "preparing") {
          await finishSession(sessionId);
          return;
        }
        if (result.data.status === "failed") {
          if (stageRef.current.name === "preparing" || stageRef.current.name === "waiting") {
            setScreen({ name: "error", title: "We couldn't prepare this round.", detail: "Start a fresh round in a moment.", retry: "prepare" });
            return;
          }
          pollTimedOutRef.current = true;
          setNotice("Some exercises couldn't be prepared. Your current answer is safe.");
        }
        if (result.data.canStart && stageRef.current.name === "preparing") {
          await withLock(() => loadNext(sessionId));
        } else if (stageRef.current.name === "waiting") {
          await withLock(() => loadNext(sessionId));
        }
      }
      if (shouldKeepPolling()) timer = setTimeout(poll, 1_300);
    };

    timer = setTimeout(poll, 900);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  // Keep one bounded poller for this session; callbacks use its stable client and session id.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedFixture, sessionId, sessionClient]);

  useEffect(() => {
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        if (event.key === "Enter") event.preventDefault();
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const element = target instanceof HTMLElement ? target : null;
      const typing = element?.isContentEditable
        || (element instanceof HTMLInputElement && element.type === "text")
        || element instanceof HTMLTextAreaElement;

      if (screen.name === "exercise" && exercise) {
        if (exercise.rung !== 4 && /^[1-4]$/.test(event.key) && !typing) {
          const index = Number(event.key) - 1;
          if (exercise.options?.[index]) {
            event.preventDefault();
            setSelected(index);
            choiceRefs.current[index]?.focus();
          }
          return;
        }
        if (event.key === "Enter") {
          if (element?.closest("button") || element?.closest("a")) return;
          event.preventDefault();
          void submitAnswer();
        }
      } else if (screen.name === "answer" && event.key === "Enter") {
        if (element?.closest("button") || element?.closest("a")) return;
        event.preventDefault();
        void continueAnswer();
      }
    };

    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  // State dependencies rebind shortcuts to the current answer without changing native control activation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, exercise, typedAnswer, selected, usedHint, sessionId, busy, sessionClient]);

  const checkForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitAnswer();
  };

  if (screen.name === "invite") {
    return <div className={styles.invite}><AccessUnavailable /></div>;
  }

  const total = Math.max(1, readiness.total || 8);
  const activeIndex = Math.min(completed, total - 1);
  const shownProgress = screen.name === "answer" ? Math.min(completed + 1, total) : completed;
  const progressLabel = `${shownProgress} of ${total} exercises`;
  const exerciseTextLength = exercise
    ? exercise.sentence.length + exercise.prompt.length + (exercise.options ?? []).reduce((sum, option) => sum + option.length, 0)
    : 0;
  const denseExercise = screen.name === "exercise" && exercise !== null && (
    exercise.sentence.length > 180
    || exercise.prompt.length > 100
    || (exercise.options ?? []).some((option) => option.length > 80)
    || exerciseTextLength > 600
  );

  return (
    <div className={styles.viewport}>
      <section className={styles.window} aria-label="Practice session">
        {screen.name === "boot" || screen.name === "preparing" || screen.name === "loading-next" || screen.name === "waiting" ? (
          <div className={styles.loadingContent} role="status" aria-live="polite">
            <div
              className={styles.progressTrack}
              aria-label={screen.name === "boot" ? "Preparing practice" : `${readiness.ready} of ${readiness.total} exercises ready`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={screen.name === "boot" ? undefined : readiness.total}
              aria-valuenow={screen.name === "boot" ? undefined : readiness.ready}
            >
              <span
                className={screen.name === "boot" ? styles.progressIndeterminate : styles.progressFill}
                style={screen.name === "boot" ? undefined : { width: `${readiness.total ? (readiness.ready / readiness.total) * 100 : 0}%` }}
              />
            </div>
            <p className={styles.loadingLine}>
              {screen.name === "waiting" ? "Your next exercise is getting ready."
                : screen.name === "loading-next" ? "Opening your next exercise."
                  : "Preparing your practice."}
            </p>
          </div>
        ) : null}

        {screen.name === "exercise" && exercise ? (
          <form className={`${styles.sessionForm} ${denseExercise ? styles.denseContent : ""}`} onSubmit={checkForm}>
            <div className={styles.sessionBody}>
              <div className={styles.segmentedProgress} role="progressbar" aria-label={progressLabel} aria-valuemin={0} aria-valuemax={total} aria-valuenow={shownProgress}>
                {Array.from({ length: total }, (_, index) => (
                  <span
                    key={index}
                    className={index < shownProgress ? styles.segmentDone : index === activeIndex ? styles.segmentCurrent : styles.segment}
                  />
                ))}
              </div>
              <p className={styles.eyebrow}>{exercise.rung === 1 ? "Recognise in context"
                : exercise.rung === 2 ? "Choose by meaning"
                  : exercise.rung === 3 ? "Fill the gap" : "Recall from memory"}</p>
              <p className={styles.hero}>{exercise.sentence}</p>
              {exercise.prompt.length > 100 ? (
                <>
                  <p className={styles.instruction}>{exercise.rung === 1 ? "Choose what fits the context."
                    : exercise.rung === 2 ? "Choose the matching word."
                      : exercise.rung === 3 ? "Complete the sentence." : "Recall the word from memory."}</p>
                  <details className={styles.promptDisclosure}>
                    <summary>Full instruction</summary>
                    <p>{exercise.prompt}</p>
                  </details>
                </>
              ) : <p className={styles.instruction}>{exercise.prompt}</p>}

              {exercise.rung === 4 ? (
                <div className={styles.recallField}>
                  <label className={styles.srOnly} htmlFor={recallId}>Your answer</label>
                  <input
                    id={recallId}
                    type="text"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={typedAnswer}
                    onChange={(event) => setTypedAnswer(event.target.value)}
                    disabled={busy}
                  />
                </div>
              ) : (
                <fieldset className={styles.optionGrid} aria-describedby={`${choiceGroupId}-hint`}>
                  <legend className={styles.srOnly}>Choose one answer</legend>
                  {exercise.options?.map((option, index) => (
                    <label className={`${styles.option} ${selected === index ? styles.optionSelected : ""}`} key={`${index}-${option}`}>
                      <input
                        ref={(node) => { choiceRefs.current[index] = node; }}
                        type="radio"
                        name={choiceGroupId}
                        value={option}
                        checked={selected === index}
                        onChange={() => setSelected(index)}
                        disabled={busy}
                      />
                      <span className={styles.optionNumber} aria-hidden="true">{index + 1}</span>
                      <span>{option}</span>
                    </label>
                  ))}
                  <span id={`${choiceGroupId}-hint`} className={styles.srOnly}>Use the number keys one through four to choose.</span>
                </fieldset>
              )}

              {hint ? <p className={styles.hintText} role="status">{hint}</p> : null}
              {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
            </div>
            <footer className={styles.footer}>
              <div className={styles.secondaryActions}>
                <button
                  className={styles.quietButton}
                  type="button"
                  onClick={() => void requestHint()}
                  disabled={busy || usedHint}
                  title="A small clue is recorded with this answer."
                >
                  {hintPending ? "Hint…" : "Hint"}
                </button>
                <button className={styles.quietButton} type="button" onClick={() => void submitAnswer(true)} disabled={busy}>
                  I don&apos;t know
                </button>
              </div>
              <button
                className={styles.primaryButton}
                type="submit"
                disabled={busy || (exercise.rung === 4 ? !typedAnswer.trim() : selected === null)}
              >
                {busy ? "Checking…" : "Check answer"}
              </button>
            </footer>
          </form>
        ) : null}

        {screen.name === "answer" && answer ? (
          <div className={`${styles.answerScreen} ${answer.correct ? styles.answerCorrect : styles.answerWrong}`}>
            <div className={styles.segmentedProgress} role="progressbar" aria-label={progressLabel} aria-valuemin={0} aria-valuemax={total} aria-valuenow={shownProgress}>
              {Array.from({ length: total }, (_, index) => (
                <span key={index} className={index < shownProgress ? styles.segmentDone : styles.segment} />
              ))}
            </div>
            <div className={styles.answerBody}>
              <p className={styles.resultLabel} role="status">{answer.correct ? "Correct" : "We’ll bring this back sooner"}</p>
              <div className={styles.wordRow}>
                <h1 className={styles.word}>{answer.word}</h1>
                <span className={styles.band} title={frequencyHelp(answer.frequency)} aria-label={frequencyHelp(answer.frequency)}>
                  {getBandLabel(answer.frequency)}
                </span>
              </div>
              <div className={styles.pronunciation}>
                <VocabularyPronunciation text={answer.word} ipa={answer.ipa} />
              </div>
              <p className={styles.meaning}>{answer.meaning}</p>
              <p className={styles.example}>{answer.example}</p>
              <p className={styles.returns}>
                {answer.comesBackText === "hidden from practice" ? "Hidden from practice." : `We’ll bring it back ${answer.comesBackText}.`}
              </p>

              <div className={styles.pathBlock}>
                <ol
                  className={styles.path}
                  aria-describedby={pathDescriptionId}
                  aria-label="Conceptual path from knowing a word to using it"
                  title="A learning path, not your stored word status."
                >
                  <li><span className={styles.pathDot} />Know</li>
                  <li><span className={styles.pathDot} />Practice</li>
                  <li><span className={styles.pathDot} />Use</li>
                </ol>
                <span id={pathDescriptionId} className={styles.srOnly}>A learning path, not your stored word status.</span>
                <div className={styles.history} aria-label="Word history, this session only" title="Earlier history isn't available here.">
                  <ol className={styles.historyList}>
                    <li><span className={styles.historyDot} aria-hidden="true" />This session · {answer.correct ? "correct" : "revisited"}</li>
                  </ol>
                </div>
              </div>

              <div className={styles.reactions} aria-label="How did that feel?">
                {REACTIONS.filter(({ key }) => answer.allowedReactions.includes(key)).map(({ key, icon }) => (
                  <button
                    key={key}
                    className={`${styles.reaction} ${answer.reaction === key ? styles.reactionSelected : ""}`}
                    type="button"
                    title={fixtureReactionLabels[key]}
                    aria-label={fixtureReactionLabels[key]}
                    aria-pressed={answer.reaction === key}
                    disabled={busy || Boolean(answer.reaction)}
                    onClick={() => void saveReaction(key)}
                  >
                    {icon}
                  </button>
                ))}
              </div>
              {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
            </div>
            <footer className={styles.footerAnswer}>
              <button className={styles.primaryButton} type="button" onClick={continueAnswer} disabled={busy}>
                {busy ? "Continuing…" : "Continue"}
              </button>
            </footer>
          </div>
        ) : null}

        {screen.name === "end" && summary ? (
          <div className={styles.endScreen}>
            <h1 className={styles.endTitle}>{summary.summary}</h1>
            <p className={styles.endLine}>{summary.correct} correct from {summary.answered} answers.</p>
            <p className={styles.endLine}>We’ll bring these words back when they’re due.</p>
            <footer className={styles.endActions}>
              <Link className={styles.quietLink} href="/editor">Back to writing</Link>
              <button className={styles.primaryButton} type="button" onClick={() => void startSession()} disabled={busy}>
                {busy ? "Preparing…" : "Start another round"}
              </button>
            </footer>
          </div>
        ) : null}

        {screen.name === "error" ? (
          <div className={styles.errorScreen}>
            <h1 className={styles.endTitle}>{screen.title}</h1>
            <p className={styles.endLine}>{screen.detail}</p>
            <footer className={styles.errorActions}>
              <Link className={styles.quietLink} href="/editor">Back to writing</Link>
              <button className={styles.primaryButton} type="button" onClick={retry} disabled={busy}>
                {busy ? "Trying…" : "Try again"}
              </button>
            </footer>
          </div>
        ) : null}
      </section>
    </div>
  );
}
