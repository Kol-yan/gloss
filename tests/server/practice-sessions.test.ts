import { beforeEach, describe, expect, it, vi } from "vitest";
import { PracticeSessionReadiness } from "@/shared/contracts";

const harness = vi.hoisted(() => ({
  afterTasks: [] as Array<() => Promise<void>>,
  failGeneration: false,
  results: [] as Array<Record<string, unknown>>,
  startRung: 4,
  waitForGeneration: null as Promise<void> | null,
  generationStarted: null as (() => void) | null,
}));

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => unknown) => {
    harness.afterTasks.push(async () => { await callback(); });
  },
}));
vi.mock("@/server/practice/word-source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/practice/word-source")>();
  const { getDb } = await import("@/server/db");
  return {
    ...actual,
    pickSessionWords: (learnerId: string, size = 8) => {
      const rows = getDb().prepare("SELECT id, text FROM expressions WHERE learner_id = ? ORDER BY created_at, id LIMIT ?")
        .all(learnerId, size) as Array<{ id: string; text: string }>;
      return rows.map((row) => ({
        expressionId: String(row.id), text: String(row.text), slot: "activate", status: "ready",
        startRung: harness.startRung, frequency: "common", why: "Common word · ready to activate",
      }));
    },
    recordPracticeResult: (input: Record<string, unknown>) => {
      harness.results.push(input);
      return actual.recordPracticeResult(input as Parameters<typeof actual.recordPracticeResult>[0]);
    },
  };
});
vi.mock("@/server/practice/exercise-pool", async () => {
  const { getDb } = await import("@/server/db");
  return {
    takePoolExercise: async (learnerId: string, expressionId: string, rung: 1 | 2 | 3 | 4) => {
      const started = harness.generationStarted;
      harness.generationStarted = null;
      started?.();
      if (harness.waitForGeneration) await harness.waitForGeneration;
      if (harness.failGeneration) throw new Error("RAW_MODEL_FAILURE_DETAIL");
      const row = getDb().prepare("SELECT text, meaning FROM expressions WHERE id = ? AND learner_id = ?")
        .get(expressionId, learnerId) as { text: string; meaning: string };
      const options = rung === 1
        ? [row.meaning, "a different idea", "another meaning", "a final meaning"]
        : [row.text, "another word", "a third word", "a fourth word"];
      return {
        id: crypto.randomUUID(), expressionId, rung,
        sentence: rung === 4 ? "The clue describes this useful idea." : `We can use ${row.text} in a sentence today.`,
        prompt: rung === 4 ? row.meaning : "Choose the best answer.",
        options: rung === 4 ? null : options,
        answer: rung === 1 ? row.meaning : row.text,
        hint: "A safe hint.", example: `Here is an example with ${row.text} in context.`,
      };
    },
  };
});

import { POST as prepareRoute } from "@/app/api/practice/sessions/route";
import { GET as readinessRoute } from "@/app/api/practice/sessions/[sessionId]/route";
import { GET as nextRoute } from "@/app/api/practice/sessions/[sessionId]/next/route";
import { POST as answerRoute } from "@/app/api/practice/sessions/[sessionId]/answers/route";
import { POST as finishRoute } from "@/app/api/practice/sessions/[sessionId]/finish/route";
import { POST as hintRoute } from "@/app/api/practice/sessions/[sessionId]/hint/route";
import { POST as reactionRoute } from "@/app/api/practice/sessions/[sessionId]/reactions/route";
import { login, installApp, db, seedExpression } from "./helpers/app";
import {
  finishPracticeSession,
  nextPracticeExercise,
  practiceSessionReadiness,
  preparePracticeSession,
} from "@/server/practice/sessions";

installApp();

const post = (body: unknown) => new Request("http://localhost/api/practice/sessions", {
  method: "POST", body: JSON.stringify(body),
});
const params = (sessionId: string) => ({ params: Promise.resolve({ sessionId }) });
const responseJson = async <T>(response: Response) => await response.json() as T;

beforeEach(() => {
  harness.afterTasks = [];
  harness.failGeneration = false;
  harness.results = [];
  harness.startRung = 4;
  harness.waitForGeneration = null;
  harness.generationStarted = null;
});

describe("practice session API", () => {
  it("starts with three ready exercises, hides the answer, persists hints, and replays submissions", async () => {
    const learner = login();
    ["careful", "steady", "useful", "likely"].forEach((text) => seedExpression(learner.learner.id, { text, meaning: `meaning of ${text}` }));
    const readiness = preparePracticeSession(learner.learner, { requestId: crypto.randomUUID(), size: 4 });
    const d = db();
    const items = d.prepare("SELECT id, expression_id, word_text, meaning, start_rung FROM practice_session_items WHERE learner_id = ? AND session_id = ? ORDER BY ordinal")
      .all(learner.learner.id, readiness.sessionId) as Array<Record<string, unknown>>;
    const first = items[0];
    const firstWord = String(first.word_text);
    const exercise = {
      id: crypto.randomUUID(), expressionId: String(first.expression_id), rung: 4,
      sentence: "The clue describes this useful idea.", prompt: `meaning of ${firstWord}`,
      options: null, answer: firstWord, hint: "private", example: `We use ${firstWord} in a full example sentence.`,
    };
    for (const item of items.slice(0, 3)) {
      const word = String(item.word_text);
      d.prepare("UPDATE practice_session_items SET status = 'ready', exercise_json = ? WHERE id = ? AND learner_id = ?")
        .run(JSON.stringify({ ...exercise, id: crypto.randomUUID(), expressionId: String(item.expression_id), answer: word,
          prompt: `meaning of ${word}`, example: `We use ${word} in a full example sentence.` }), String(item.id), learner.learner.id);
    }
    d.prepare("UPDATE practice_sessions SET status = 'ready' WHERE id = ? AND learner_id = ?")
      .run(readiness.sessionId, learner.learner.id);

    const ready = practiceSessionReadiness(learner.learner.id, readiness.sessionId);
    expect(ready).toMatchObject({ ready: 3, total: 4, canStart: true, status: "ready" });
    expect(JSON.stringify(ready)).not.toContain(firstWord);

    const next = await responseJson<{ status: string; exercise: Record<string, unknown> }>(
      await nextRoute(new Request("http://localhost"), params(readiness.sessionId)),
    );
    expect(next.status).toBe("ready");
    expect(next.exercise).not.toHaveProperty("answer");
    expect(next.exercise).not.toHaveProperty("example");
    expect(next.exercise).not.toHaveProperty("hint");
    expect(next.exercise).not.toHaveProperty("ipa");

    const exerciseId = String(next.exercise.exerciseId);
    const earlyReaction = await reactionRoute(post({ exerciseId, reaction: "too_easy" }), params(readiness.sessionId));
    expect(earlyReaction.status).toBe(409);
    expect(harness.results).toHaveLength(0);

    const hint = await responseJson<{ hint: string }>(await hintRoute(post({ exerciseId }), params(readiness.sessionId)));
    expect(hint.hint).not.toContain(firstWord);
    expect(d.prepare("SELECT hint_used FROM practice_session_items WHERE id = ? AND learner_id = ?")
      .get(exerciseId, learner.learner.id)).toMatchObject({ hint_used: 1 });

    const submission = { exerciseId, answer: firstWord, usedHint: false };
    const firstAnswer = await answerRoute(post(submission), params(readiness.sessionId));
    expect(firstAnswer.status).toBe(200);
    const answerBody = await responseJson<{ answer: { correct: boolean; word: string; frequency: string; ipa: string | null; meaning: string; example: string } }>(firstAnswer);
    expect(answerBody.answer).toMatchObject({ correct: true, word: firstWord, frequency: "common", meaning: `meaning of ${firstWord}` });
    expect(answerBody.answer.example).toContain(firstWord);
    expect(harness.results).toHaveLength(1);
    expect(harness.results[0]).toMatchObject({ productive: false, correct: true, usedHint: true });

    const replay = await responseJson(await answerRoute(post(submission), params(readiness.sessionId)));
    expect(replay).toEqual(answerBody);
    expect(harness.results).toHaveLength(1);

    const reaction = await reactionRoute(post({ exerciseId, reaction: "already_know" }), params(readiness.sessionId));
    expect(reaction.status).toBe(200);
    expect(harness.results).toHaveLength(2);
    expect(harness.results[1]).toMatchObject({ productive: false, usedHint: true, reaction: "already_know" });

    const issuedId = String(items[1].id);
    d.prepare("UPDATE practice_session_items SET status = 'issued', issued_at = ? WHERE id = ? AND learner_id = ?")
      .run(new Date().toISOString(), issuedId, learner.learner.id);
    const finished = await responseJson(await finishRoute(new Request("http://localhost", { method: "POST" }), params(readiness.sessionId)));
    expect(finished).toMatchObject({ sessionId: readiness.sessionId, answered: 1, correct: 1, total: 4 });
    const finishedAgain = await responseJson(await finishRoute(new Request("http://localhost", { method: "POST" }), params(readiness.sessionId)));
    expect(finishedAgain).toEqual(finished);
    expect(finishPracticeSession(learner.learner.id, readiness.sessionId)).toEqual(finished);
    expect(d.prepare("SELECT status FROM practice_session_items WHERE id = ? AND learner_id = ?")
      .get(issuedId, learner.learner.id)).toMatchObject({ status: "failed" });
    expect((await answerRoute(post({ exerciseId: issuedId, answer: "useful", usedHint: false }), params(readiness.sessionId))).status).toBe(409);
  });

  it("runs prepare, readiness, next, answer, and finish with the real checker and word adapter", async () => {
    const learner = login();
    const { expressionId } = seedExpression(learner.learner.id, { text: "careful" });
    const requestId = crypto.randomUUID();
    const prepared = await responseJson<PracticeSessionReadiness>(await prepareRoute(post({ requestId, size: 1 })));
    expect(prepared).toMatchObject({ ready: 0, total: 1, status: "preparing", canStart: false });
    expect(harness.afterTasks).toHaveLength(1);
    await Promise.all(harness.afterTasks.splice(0).map((task) => task()));

    const ready = await responseJson<PracticeSessionReadiness>(
      await readinessRoute(new Request("http://localhost"), params(prepared.sessionId)),
    );
    expect(ready).toMatchObject({ ready: 1, total: 1, canStart: true, status: "ready" });
    const next = await responseJson<{ exercise: { exerciseId: string; rung: number; options: null } }>(
      await nextRoute(new Request("http://localhost"), params(prepared.sessionId)),
    );
    expect(next.exercise).toMatchObject({ rung: 4, options: null });
    const answer = await responseJson<{ answer: { correct: boolean } }>(await answerRoute(
      post({ exerciseId: next.exercise.exerciseId, answer: "careful", usedHint: false }), params(prepared.sessionId),
    ));
    expect(answer.answer.correct).toBe(true);
    const progress = db().prepare("SELECT productive_successes FROM practice_word_progress WHERE learner_id = ? AND expression_id = ?")
      .get(learner.learner.id, expressionId) as { productive_successes: number };
    expect(progress.productive_successes).toBe(1);
    expect(harness.results[0]).toMatchObject({ productive: true, correct: true, usedHint: false });
    const summary = await responseJson<{ answered: number; correct: number }>(
      await finishRoute(new Request("http://localhost", { method: "POST" }), params(prepared.sessionId)),
    );
    expect(summary).toMatchObject({ answered: 1, correct: 1 });
  });

  it("accepts I don't know on a choice item without awarding productive credit", async () => {
    harness.startRung = 1;
    const learner = login();
    const { expressionId } = seedExpression(learner.learner.id, { text: "careful", meaning: "paying attention" });
    const prepared = preparePracticeSession(learner.learner, { requestId: crypto.randomUUID(), size: 1 });
    await (await import("@/server/practice/sessions")).continuePracticePreparation(
      learner.learner.id, prepared.sessionId, { provider: "meta" },
    );
    const next = nextPracticeExercise(learner.learner.id, prepared.sessionId);
    expect(next.exercise?.rung).toBe(1);
    const response = await answerRoute(post({ exerciseId: next.exercise?.exerciseId, answer: "", usedHint: false, dontKnow: true }), params(prepared.sessionId));
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({ answer: { correct: false } });
    const progress = db().prepare("SELECT productive_successes, wrong_streak FROM practice_word_progress WHERE learner_id = ? AND expression_id = ?")
      .get(learner.learner.id, expressionId) as { productive_successes: number; wrong_streak: number };
    expect(progress).toEqual({ productive_successes: 0, wrong_streak: 1 });
  });

  it("does not let a stale failed worker terminalize its replacement lease", async () => {
    const learner = login();
    seedExpression(learner.learner.id, { text: "replacement" });
    const prepared = preparePracticeSession(learner.learner, { requestId: crypto.randomUUID(), size: 1 });
    let release!: () => void;
    let started!: () => void;
    harness.waitForGeneration = new Promise<void>((resolve) => { release = resolve; });
    const generationStarted = new Promise<void>((resolve) => { started = resolve; });
    harness.generationStarted = started;
    harness.failGeneration = true;
    const work = (await import("@/server/practice/sessions")).continuePracticePreparation(
      learner.learner.id, prepared.sessionId, { provider: "meta" },
    );
    await generationStarted;
    const item = db().prepare("SELECT id, generation_id FROM practice_session_items WHERE learner_id = ? AND session_id = ?")
      .get(learner.learner.id, prepared.sessionId) as { id: string; generation_id: string };
    db().prepare("UPDATE practice_session_items SET generation_id = 'replacement-lease' WHERE id = ? AND learner_id = ?")
      .run(item.id, learner.learner.id);
    release();
    await work;
    expect(db().prepare("SELECT status, generation_id FROM practice_session_items WHERE id = ? AND learner_id = ?")
      .get(item.id, learner.learner.id)).toMatchObject({ status: "generating", generation_id: "replacement-lease" });
    expect(practiceSessionReadiness(learner.learner.id, prepared.sessionId).status).toBe("preparing");
  });

  it("keeps learner isolation and never returns provider error text from preparation", async () => {
    const learner = login();
    const { expressionId } = seedExpression(learner.learner.id, { text: "distinct" });
    const other = login();
    const id = crypto.randomUUID();
    const prepared = preparePracticeSession(learner.learner, { requestId: id, size: 1 });
    expect(() => practiceSessionReadiness(other.learner.id, prepared.sessionId)).toThrow();
    expect(PracticeSessionReadiness.safeParse(prepared).success).toBe(true);

    // Use the signed-in learner's own word for the API error containment check.
    expect(expressionId).toBeTruthy();
    harness.failGeneration = true;
    const failureLearner = login();
    seedExpression(failureLearner.learner.id, { text: "failure case" });
    const response = await prepareRoute(post({ requestId: crypto.randomUUID(), size: 1 }));
    const body = await responseJson<Record<string, unknown>>(response);
    expect(JSON.stringify(body)).not.toContain("RAW_MODEL_FAILURE_DETAIL");
    expect(harness.afterTasks).toHaveLength(1);
    await Promise.all(harness.afterTasks.splice(0).map((task) => task()));

    const failedId = String(body.sessionId);
    const failed = await readinessRoute(new Request("http://localhost"), params(failedId));
    const failedBody = await responseJson<Record<string, unknown>>(failed);
    expect(failedBody.status).toBe("failed");
    expect(JSON.stringify(failedBody)).not.toContain("RAW_MODEL_FAILURE_DETAIL");
    expect(nextPracticeExercise(learner.learner.id, prepared.sessionId)).toEqual({ status: "waiting", exercise: null });
  });
});
