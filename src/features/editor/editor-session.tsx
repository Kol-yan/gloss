"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { InviteRequired } from "@/components/invite-required";
import {
  createExpression,
  detect,
  getMe,
  isAiOff,
  isQuota,
  isUnauthorized,
  proofread,
  recordDecision,
} from "@/features/api/client";
import { getAccessSnapshot } from "@/features/api/access-store";
import { useLoad } from "@/features/api/use-load";
import { useAccess } from "@/features/api/use-access";
import { SELECTION_NOTICE } from "@/features/capture/selection";
import { getSelectionSnapshot, getServerSelectionSnapshot, subscribeSelection } from "@/features/capture/selection-store";
import type { Familiarity, PracticeOffer } from "@/features/practice/types";
import { hashText } from "@/lib/text";
import type { Suggestion } from "@/shared/contracts";
import { EditorScreen } from "./editor-screen";
import { checkLocal, getLocalCheckerStatus, getServerLocalCheckerStatus, subscribeLocalChecker } from "./local-checker";
import { bindToLearner, type DetectOutcome, type DetectSentences } from "./sentence-detect";
import { NO_RECHECK, type CheckWithAi, type ProofreadOutcome, type RecheckSentences } from "./types";

// `/join/{token}` sends people here with ?invite=invalid when the link did not work.
function InviteNotice() {
  const invalid = useSearchParams().get("invite") === "invalid";
  const [dismissed, setDismissed] = useState(false);
  if (!invalid || dismissed) return null;
  return (
    <div
      role="status"
      className="mx-auto mt-3 flex w-full max-w-6xl shrink-0 items-center justify-between gap-3 px-4"
    >
      <p className="flex-1 rounded-chip bg-caution-soft px-3 py-2 text-sm font-semibold text-caution">
        That invite link didn&apos;t work. It may have expired or been used already. Ask for a new one.
      </p>
      <button type="button" onClick={() => setDismissed(true)} className="text-sm font-medium text-ink-muted underline underline-offset-4 hover:text-ink">
        Dismiss
      </button>
    </div>
  );
}

// A decision is a courtesy to the server's records; failing to send it must never disturb writing.
async function safeHash(text: string): Promise<string> {
  try {
    return await hashText(text);
  } catch {
    // crypto.subtle only exists on secure origins; the server does not check this value.
    return "";
  }
}

// Connects the editor to the account: quota, cloud checks, decisions and practice.
// `recheckSentences` receives the sentences an applied cloud suggestion changed;
// it does nothing until a sentence-level check is plugged in.
export function EditorSession({ recheckSentences = NO_RECHECK }: { recheckSentences?: RecheckSentences } = {}) {
  const router = useRouter();
  const access = useAccess();
  const capture = useSyncExternalStore(subscribeSelection, getSelectionSnapshot, getServerSelectionSnapshot);
  const localCheckStatus = useSyncExternalStore(subscribeLocalChecker, getLocalCheckerStatus, getServerLocalCheckerStatus);
  const { result: me, reload } = useLoad(getMe);
  const [sessionLost, setSessionLost] = useState(false);
  // Decisions are fire-and-forget, but "start practice" must wait for the matching "accepted".
  const decisions = useRef(new Map<string, Promise<unknown>>());

  const checkWithAi: CheckWithAi = useCallback(async (text): Promise<ProofreadOutcome> => {
    const result = await proofread(text);
    if (result.ok) {
      const { quota, suggestions } = result.data;
      return { ok: true, suggestions, checksLeft: Math.max(0, quota.limit - quota.used) };
    }
    if (isUnauthorized(result)) setSessionLost(true);
    if (isQuota(result)) return { ok: false, reason: "quota" };
    if (isAiOff(result)) return { ok: false, reason: "unavailable" };
    return { ok: false, reason: "failed" };
  }, []);

  // Stage 1. Failures are quiet: the learner never asked for this call, so only
  // "quota" and "unavailable" change what the editor says.
  const sendSentences: DetectSentences = useCallback(async (sentences): Promise<DetectOutcome> => {
    const result = await detect(sentences);
    if (result.ok) {
      const { sentences: answers, quota } = result.data;
      return {
        ok: true,
        results: answers.map((answer) => ({
          hash: answer.hash,
          scores: {
            correction: answer.needs_correction,
            clarity: answer.needs_clarity,
            word_choice: answer.needs_word_choice,
          },
        })),
        checksLeft: Math.max(0, quota.limit - quota.used),
      };
    }
    if (isUnauthorized(result)) setSessionLost(true);
    if (isQuota(result)) return { ok: false, reason: "quota" };
    if (isAiOff(result)) return { ok: false, reason: "unavailable" };
    if (result.code === "rate_limited") return { ok: false, reason: "busy" };
    return { ok: false, reason: "failed" };
  }, []);
  // The text belongs to the learner who is signed in now. Every request re-checks
  // that, so a queue that outlives a sign-out or an account switch sends nothing.
  const learnerId = access.session?.learner.id ?? null;
  const detectSentences = useMemo(
    () => bindToLearner(sendSentences, learnerId, () => getAccessSnapshot().session?.learner.id ?? null),
    [sendSentences, learnerId],
  );

  const onDecision = useCallback((suggestion: Suggestion, decision: "accepted" | "rejected" | "stale", text: string) => {
    // Only cloud suggestions exist on the server.
    if (suggestion.source !== "ai") return;
    const sent = safeHash(text)
      .then((hash) => recordDecision(suggestion.id, decision, hash))
      .catch(() => undefined);
    decisions.current.set(suggestion.id, sent);
  }, []);

  const onStartPractice = useCallback(
    async (offer: PracticeOffer, familiarity: Familiarity): Promise<boolean> => {
      await decisions.current.get(offer.suggestionId);
      const result = await createExpression({ suggestionId: offer.suggestionId, familiarity });
      if (result.ok) {
        router.push(`/practice?expression=${encodeURIComponent(result.data.expression.id)}`);
        return true;
      }
      if (isUnauthorized(result)) setSessionLost(true);
      return false;
    },
    [router],
  );

  const unauthorized = sessionLost || (access.checked && !access.session) || (me?.ok === false && isUnauthorized(me));
  const quota = me?.ok ? me.data.quotas.proofread : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Suspense fallback={null}>
        <InviteNotice />
      </Suspense>
      {capture.result ? (
        <p role="status" className="mx-auto w-full max-w-6xl shrink-0 px-4 pt-2 text-sm text-ink-muted">
          {SELECTION_NOTICE[capture.result.status]}
        </p>
      ) : null}
      {unauthorized ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <InviteRequired
            onRetry={() => {
              setSessionLost(false);
              reload();
            }}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <EditorScreen
            key={`${learnerId ?? "pending"}:${capture.revision}`}
            initialText={capture.result?.status === "accepted" ? capture.result.text : ""}
            checksLeft={quota ? Math.max(0, quota.limit - quota.used) : null}
            aiAvailable={me?.ok ? me.data.aiEnabled && (me.data.accessMode !== "byok" || access.hasKey) : false}
            checkWithAi={checkWithAi}
            detectSentences={detectSentences}
            checkLocal={checkLocal}
            localCheckStatus={localCheckStatus}
            onDecision={onDecision}
            onStartPractice={onStartPractice}
            recheckSentences={recheckSentences}
          />
        </div>
      )}
    </div>
  );
}
