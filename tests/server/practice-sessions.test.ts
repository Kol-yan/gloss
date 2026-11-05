import { beforeEach, describe, expect, it, vi } from "vitest";
import { PracticeSessionReadiness } from "@/shared/contracts";

const harness = vi.hoisted(() => ({
  afterTasks: [] as Array<() => Promise<void>>,
  failGeneration: false,
  fallbackRung: null as 1 | 2 | 3 | 4 | null,
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
vi.mock("@/server/practice/exercise-pool", async () => {
  const { getDb } = await import("@/server/db");
  const { starterEntry } = await import("@/server/learning/starter");
  return {
    takePoolExercise: async (learnerId: string, expressionId: string, rung: 1 | 2 | 3 | 4) => {
      const started = harness.generationStarted;
      harness.generationStarted = null;
      started?.();
      if (harness.waitForGeneration) await harness.waitForGeneration;
      if (harness.failGeneration) throw new Error("RAW_MODEL_FAILURE_DETAIL");
      const db = getDb();
      const saved = db.prepare("SELECT text, meaning FROM expressions WHERE id = ? AND learner_id = ?")
        .get(expressionId, learnerId) as { text: string; meaning: string } | undefined;
      const word = saved ?? (() => {
        const stored = db.prepare("SELECT text FROM word_progress WHERE expression_id = ? AND learner_id = ?")
          .get(expressionId, learnerId) as { text: string } | undefined;
        const curated = stored ? starterEntry(stored.text) : undefined;
        return curated ? { text: curated.text, meaning: curated.definition } : undefined;
      })();
      if (!word) throw new Error("Practice word is unavailable");
      rung = harness.fallbackRung ?? rung;
      const options = rung === 1
        ? [word.meaning, "a different idea", "another meaning", "a final meaning"]
        : [word.text, "another word", "a third word", "a fourth word"];
      return {
        id: crypto.randomUUID(), expressionId, rung,
        sentence: rung === 4 ? "The clue describes this useful idea." : `We can use ${word.text} in a sentence today.`,
        prompt: rung === 4 ? word.meaning : "Choose the best answer.",
        options: rung === 4 ? null : options,
        answer: rung === 1 ? word.meaning : word.text,
        hint: "A safe hint.", example: `Here is an example with ${word.text} in context.`,
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
import { normalizeWord } from "@/server/learning/priority/intake";
import { starterEntry, starterSet } from "@/server/learning/starter";
import { newId } from "@/server/ids";
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

function seedEngineWord(
  learnerId: string,
  expressionId: string,
  text: string,
  status: "learning" | "ready" | "active",
  rung: number,
  source: "saved" | "starter" | "word_check" = "saved",
) {
  const now = new Date().toISOString();
  db().prepare(`INSERT INTO word_progress
    (expression_id, learner_id, text, normalized, source, status, band, rung, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'core', ?, ?, ?)`)
    .run(expressionId, learnerId, text, normalizeWord(text), source, status, rung, now, now);
}

beforeEach(() => {
  harness.afterTasks = [];
  harness.failGeneration = false;
  harness.fallbackRung = null;
  harness.waitForGeneration = null;
  harness.generationStarted = null;
});

describe("practice session API", () => {
  it("uses the engine's 3 activate, 3 learn, 2 keep mix", () => {
    const learner = login();
    const activate = ["focus", "steady", "careful"];
    const learn = ["unfamiliar-a", "unfamiliar-b", "unfamiliar-c"];
    const keep = ["active-a", "active-b"];
    for (const text of activate) {
      const { expressionId } = seedExpression(learner.learner.id, { text });
      db().prepare("UPDATE expressions SET familiarity = 'known_unused' WHERE id = ?").run(expressionId);
    }
    for (const text of learn) seedExpression(learner.learner.id, { text });
    for (const text of keep) {
      const { expressionId } = seedExpression(learner.learner.id, { text });
      seedEngineWord(learner.learner.id, expressionId, text, "active", 4);
    }

    const session = preparePracticeSession(learner.learner, { requestId: crypto.randomUUID(), size: 8 });
    const slots = db().prepare("SELECT slot, COUNT(*) AS n FROM practice_session_items WHERE learner_id = ? AND session_id = ? GROUP BY slot")
      .all(learner.learner.id, session.sessionId);
    expect(slots).toEqual([
      { slot: "activate", n: 3 },
      { slot: "keep", n: 2 },
      { slot: "learn", n: 3 },
    ]);
  });

  it("does not spend another new-word place when a prepare request is replayed", () => {
    const learner = login();
    for (const text of ["fresh-a", "fresh-b", "fresh-c", "fresh-d"]) seedExpression(learner.learner.id, { text });
    const requestId = crypto.randomUUID();
    const first = preparePracticeSession(learner.learner, { requestId, size: 1 });
    const firstWord = db().prepare("SELECT expression_id FROM practice_session_items WHERE learner_id = ? AND session_id = ?")
      .get(learner.learner.id, first.sessionId) as { expression_id: string };
    db().prepare("UPDATE word_progress SET status = 'hidden' WHERE learner_id = ? AND expression_id = ?")
      .run(learner.learner.id, firstWord.expression_id);
    const introduced = () => Number(db().prepare(
      "SELECT COUNT(*) AS n FROM word_progress WHERE learner_id = ? AND introduced_on IS NOT NULL",
    ).get(learner.learner.id)?.n);
    expect(introduced()).toBe(1);
    const replay = preparePracticeSession(learner.learner, { requestId, size: 1 });
    expect(replay.sessionId).toBe(first.sessionId);
    expect(introduced()).toBe(1);
    preparePracticeSession(learner.learner, { requestId: crypto.randomUUID(), size: 1 });
    expect(introduced()).toBe(2);
  });

  it("prepares and scores a Word check word without an expressions row", async () => {
    const learner = login();
    const entry = starterSet().entries[0];
    const expressionId = newId();
    const now = new Date("2026-11-04T12:00:00.000Z");
    db().prepare(`INSERT INTO word_progress
      (expression_id, learner_id, text, normalized, source, status, band, rung,
       word_check_answer, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'word_check', 'ready', ?, 2, 'know_unused', ?, ?)`)
      .run(expressionId, learner.learner.id, entry.text, normalizeWord(entry.text), entry.band, now.toISOString(), now.toISOString());

    const prepared = preparePracticeSession(learner.learner, { requestId: crypto.randomUUID(), size: 1 }, { db: db(), now });
    const item = db().prepare("SELECT id, expression_id, meaning, ipa FROM practice_session_items WHERE learner_id = ? AND session_id = ?")
      .get(learner.learner.id, prepared.sessionId) as { id: string; expression_id: string; meaning: string; ipa: string | null };
    expect(item).toMatchObject({ expression_id: expressionId, meaning: entry.definition, ipa: null });
    expect(db().prepare("SELECT 1 AS found FROM expressions WHERE id = ? AND learner_id = ?").get(expressionId, learner.learner.id)).toBeUndefined();

    await (await import("@/server/practice/sessions")).continuePracticePreparation(
      learner.learner.id, prepared.sessionId, { provider: "meta" }, { db: db(), now },
    );
    const ready = nextPracticeExercise(learner.learner.id, prepared.sessionId, { db: db(), now });
    expect(ready.exercise).toMatchObject({ rung: 2 });
    const answer = await answerRoute(
      post({ exerciseId: item.id, answer: entry.text, usedHint: false }),
      params(prepared.sessionId),
    );
    expect(answer.status).toBe(200);
    expect(db().prepare("SELECT source, answers, correct_answers FROM word_progress WHERE learner_id = ? AND expression_id = ?")
      .get(learner.learner.id, expressionId)).toEqual({ source: "word_check", answers: 1, correct_answers: 1 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM practice_word_progress WHERE learner_id = ?").get(learner.learner.id)).toEqual({ n: 0 });
  });

  it("starts with three ready exercises, hides the answer, persists hints, and replays submissions", async () => {
    const learner = login();
    const expressions = ["careful", "steady", "useful", "likely"].map((text) => ({
      text,
      ...seedExpression(learner.learner.id, { text, meaning: `meaning of ${text}` }),
    }));
    db().prepare("UPDATE expressions SET familiarity = 'known_unused' WHERE id = ?").run(expressions[0].expressionId);
    const readiness = preparePracticeSession(learner.learner, { requestId: crypto.randomUUID(), size: 4 });
    const d = db();
    const items = d.prepare("SELECT id, expression_id, word_text, meaning, start_rung, frequency FROM practice_session_items WHERE learner_id = ? AND session_id = ? ORDER BY ordinal")
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
    expect(d.prepare("SELECT COUNT(*) AS n FROM word_practice_events WHERE learner_id = ?").get(learner.learner.id)).toEqual({ n: 0 });

    const hint = await responseJson<{ hint: string }>(await hintRoute(post({ exerciseId }), params(readiness.sessionId)));
    expect(hint.hint).not.toContain(firstWord);
    expect(d.prepare("SELECT hint_used FROM practice_session_items WHERE id = ? AND learner_id = ?")
      .get(exerciseId, learner.learner.id)).toMatchObject({ hint_used: 1 });

    const submission = { exerciseId, answer: firstWord, usedHint: false };
    const firstAnswer = await answerRoute(post(submission), params(readiness.sessionId));
    expect(firstAnswer.status).toBe(200);
    const answerBody = await responseJson<{ answer: { correct: boolean; word: string; frequency: string; ipa: string | null; meaning: string; example: string } }>(firstAnswer);
    expect(answerBody.answer).toMatchObject({ correct: true, word: firstWord, frequency: String(first.frequency), meaning: `meaning of ${firstWord}` });
    expect(answerBody.answer.example).toContain(firstWord);
    expect(d.prepare("SELECT answers, correct_answers FROM word_progress WHERE learner_id = ? AND expression_id = ?")
      .get(learner.learner.id, String(first.expression_id))).toEqual({ answers: 1, correct_answers: 1 });

    const replay = await responseJson(await answerRoute(post(submission), params(readiness.sessionId)));
    expect(replay).toEqual(answerBody);
    expect(d.prepare("SELECT COUNT(*) AS n FROM word_practice_events WHERE learner_id = ? AND expression_id = ?")
      .get(learner.learner.id, String(first.expression_id))).toEqual({ n: 1 });

    const reaction = await reactionRoute(post({ exerciseId, reaction: "already_know" }), params(readiness.sessionId));
    expect(reaction.status).toBe(200);
    expect(d.prepare("SELECT answers, correct_answers, status FROM word_progress WHERE learner_id = ? AND expression_id = ?")
      .get(learner.learner.id, String(first.expression_id))).toMatchObject({ answers: 1, correct_answers: 1, status: "active" });
    expect(d.prepare("SELECT COUNT(*) AS n FROM word_practice_events WHERE learner_id = ? AND expression_id = ? AND reaction = 'already_know'")
      .get(learner.learner.id, String(first.expression_id))).toEqual({ n: 1 });

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
    seedEngineWord(learner.learner.id, expressionId, "careful", "active", 4);
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
    const progress = db().prepare("SELECT productive_answers FROM word_progress WHERE learner_id = ? AND expression_id = ?")
      .get(learner.learner.id, expressionId) as { productive_answers: number };
    expect(progress.productive_answers).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS n FROM practice_word_progress WHERE learner_id = ?").get(learner.learner.id)).toEqual({ n: 0 });
    const summary = await responseJson<{ answered: number; correct: number }>(
      await finishRoute(new Request("http://localhost", { method: "POST" }), params(prepared.sessionId)),
    );
    expect(summary).toMatchObject({ answered: 1, correct: 1 });
  });

  it("accepts I don't know on a choice item without awarding productive credit", async () => {
    const learner = login();
    const { expressionId } = seedExpression(learner.learner.id, { text: "careful", meaning: "paying attention" });
    seedEngineWord(learner.learner.id, expressionId, "careful", "learning", 1);
    const prepared = preparePracticeSession(learner.learner, { requestId: crypto.randomUUID(), size: 1 });
    await (await import("@/server/practice/sessions")).continuePracticePreparation(
      learner.learner.id, prepared.sessionId, { provider: "meta" },
    );
    const next = nextPracticeExercise(learner.learner.id, prepared.sessionId);
    expect(next.exercise?.rung).toBe(1);
    const response = await answerRoute(post({ exerciseId: next.exercise?.exerciseId, answer: "", usedHint: false, dontKnow: true }), params(prepared.sessionId));
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({ answer: { correct: false } });
    const progress = db().prepare("SELECT productive_answers, consecutive_errors FROM word_progress WHERE learner_id = ? AND expression_id = ?")
      .get(learner.learner.id, expressionId) as { productive_answers: number; consecutive_errors: number };
    expect(progress).toEqual({ productive_answers: 0, consecutive_errors: 1 });
  });

  it("serves a surviving lower rung and records its actual learning evidence", async () => {
    const learner = login();
    const { expressionId } = seedExpression(learner.learner.id, { text: "careful", meaning: "paying attention" });
    seedEngineWord(learner.learner.id, expressionId, "careful", "active", 4);
    harness.fallbackRung = 1;
    const prepared = preparePracticeSession(learner.learner, { requestId: crypto.randomUUID(), size: 1 });
    await (await import("@/server/practice/sessions")).continuePracticePreparation(
      learner.learner.id, prepared.sessionId, { provider: "meta" },
    );
    const next = nextPracticeExercise(learner.learner.id, prepared.sessionId);
    expect(next.exercise).toMatchObject({ rung: 1 });
    const response = await answerRoute(
      post({ exerciseId: next.exercise?.exerciseId, answer: "paying attention", usedHint: false }),
      params(prepared.sessionId),
    );
    expect(response.status).toBe(200);
    expect(db().prepare("SELECT rung, productive FROM word_practice_events WHERE learner_id = ? AND expression_id = ?")
      .get(learner.learner.id, expressionId)).toEqual({ rung: 1, productive: 0 });
  });

  it("maps engine rungs five and six to the served rung-four recall exercise", async () => {
    const learner = login();
    const { expressionId } = seedExpression(learner.learner.id, { text: "careful", meaning: "paying attention" });
    seedEngineWord(learner.learner.id, expressionId, "careful", "active", 6);
    const prepared = preparePracticeSession(learner.learner, { requestId: crypto.randomUUID(), size: 1 });
    expect(db().prepare("SELECT start_rung FROM practice_session_items WHERE learner_id = ? AND session_id = ?")
      .get(learner.learner.id, prepared.sessionId)).toEqual({ start_rung: 6 });
    await (await import("@/server/practice/sessions")).continuePracticePreparation(
      learner.learner.id, prepared.sessionId, { provider: "meta" },
    );
    const next = nextPracticeExercise(learner.learner.id, prepared.sessionId);
    expect(next.exercise).toMatchObject({ rung: 4 });
    const response = await answerRoute(
      post({ exerciseId: next.exercise?.exerciseId, answer: "careful", usedHint: false }),
      params(prepared.sessionId),
    );
    expect(response.status).toBe(200);
    expect(db().prepare("SELECT productive_answers FROM word_progress WHERE learner_id = ? AND expression_id = ?")
      .get(learner.learner.id, expressionId)).toEqual({ productive_answers: 1 });
    expect(db().prepare("SELECT rung, productive FROM word_practice_events WHERE learner_id = ? AND expression_id = ?")
      .get(learner.learner.id, expressionId)).toEqual({ rung: 4, productive: 1 });
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
