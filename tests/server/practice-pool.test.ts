import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { setAiEnabled } from "@/server/budget";
import { loadConfig } from "@/server/config";
import { newId } from "@/server/ids";
import { AiDisabledError, BudgetExhaustedError, NotFoundError, QuotaExceededError } from "@/server/errors";
import { ModelOutputError } from "@/server/models/errors";
import { takePoolExercise } from "@/server/practice/exercise-pool";
import { normalizeForMatch } from "@/server/practice/text";
import { starterSet } from "@/server/learning/starter";
import { normalizeWord } from "@/server/learning/priority/intake";
import { createTempDb, insertLearner } from "./helpers/db";

const TARGET = "take a rain check";
const MEANING = "politely decline now and accept later";
const AT = new Date("2026-11-03T00:00:00.000Z");

function bundle(prefix = "first") {
  const make = (rung: number, sentence: string, prompt: string, options: string[] | null, answer: string) => ({
    rung, sentence, prompt, options, answer, hint: "Think about the situation.",
    example: `A friend said they would ${TARGET} after work.`,
  });
  return { exercises: [
    make(1, `${prefix} sentence one: The invite arrived late, so I had to ${TARGET}.`, "What does the phrase mean here?", [MEANING, "accept immediately", "cancel permanently", "ask for directions"], MEANING),
    make(1, `${prefix} sentence two: She will ${TARGET} and meet us next week.`, "What does the phrase mean here?", [MEANING, "accept immediately", "cancel permanently", "ask for directions"], MEANING),
    make(2, `${prefix} context one: We can move our lunch to Friday.`, `Which phrase means ${MEANING}?`, [TARGET, "make a reservation", "take a shortcut", "keep in touch"], TARGET),
    make(2, `${prefix} context two: The meeting can happen another day.`, `Which phrase means ${MEANING}?`, [TARGET, "make a reservation", "take a shortcut", "keep in touch"], TARGET),
    make(3, `${prefix} gap one: I cannot come today, but I can ___ for next week.`, "Choose the expression that completes the gap.", [TARGET, "make a rain check", "take a short break", "keep an appointment"], TARGET),
    make(3, `${prefix} gap two: We should ___ until our schedules match.`, "Choose the expression that completes the gap.", [TARGET, "make a rain check", "take a short break", "keep an appointment"], TARGET),
    make(4, `${prefix} recall one: Your friend invites you out, but you are busy today.`, `What phrase means ${MEANING}?`, null, TARGET),
    make(4, `${prefix} recall two: You want to postpone a social plan politely.`, `What phrase means ${MEANING}?`, null, TARGET),
  ] };
}

function setup(profile: "pilot" | "judge" | "owner" = "judge") {
  const temp = createTempDb();
  const learnerId = insertLearner(temp.db, profile);
  const checkId = newId();
  const suggestionId = newId();
  const expressionId = newId();
  temp.db.prepare(`INSERT INTO check_runs (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
    VALUES (?, ?, ?, 'hash', 1, 'test', 'test', 'ok', ?)`)
    .run(checkId, learnerId, newId(), AT.toISOString());
  temp.db.prepare(`INSERT INTO suggestions (id, check_run_id, learner_id, start, end, original, replacement, category, reason, meaning)
    VALUES (?, ?, ?, 0, 1, 'x', ?, 'expression', 'test', ?)`)
    .run(suggestionId, checkId, learnerId, TARGET, MEANING);
  temp.db.prepare(`INSERT INTO expressions (id, learner_id, suggestion_id, text, meaning, familiarity, created_at)
    VALUES (?, ?, ?, ?, ?, 'new', ?)`)
    .run(expressionId, learnerId, suggestionId, TARGET, MEANING, AT.toISOString());
  temp.db.prepare(`INSERT INTO word_progress
    (expression_id, learner_id, text, normalized, source, status, band, rung, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'saved', 'learning', 'common', 1, ?, ?)`)
    .run(expressionId, learnerId, TARGET, normalizeWord(TARGET), AT.toISOString(), AT.toISOString());
  return { ...temp, learnerId, expressionId, config: loadConfig({
    OPENROUTER_API_KEY: ["sk", "or", "v1", "1234567890123456"].join("-"), PRACTICE_GENERATION_TIER: "fast",
  }) };
}

function installResponse(payload: unknown) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toContain("chat/completions");
    expect(init?.method).toBe("POST");
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 200, cost: 0.001 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function starterBundle(target: string, meaning: string) {
  const make = (rung: number, sentence: string, prompt: string, options: string[] | null, answer: string) => ({
    rung, sentence, prompt, options, answer, hint: "Think about the context.",
    example: `This sentence shows ${target} in a clear context for practice.`,
  });
  return { exercises: [
    make(1, `This sentence uses ${target} naturally in a short example today.`, "What does the expression mean?", [meaning, "a different idea", "another meaning", "a final meaning"], meaning),
    make(1, `We heard ${target} while discussing the new plan.`, "What does the expression mean?", [meaning, "a different idea", "another meaning", "a final meaning"], meaning),
    make(2, "The team moved lunch to Friday morning.", `Which expression means ${meaning}?`, [target, "make a reservation", "take a shortcut", "keep in touch"], target),
    make(2, "The appointment can happen another day.", `Which expression means ${meaning}?`, [target, "make a reservation", "take a shortcut", "keep in touch"], target),
    make(3, "We can ___ before the next meeting this week.", "Choose the expression that completes the sentence.", [target, "make a reservation", "take a shortcut", "keep in touch"], target),
    make(3, "They decided to ___ after reading the latest update.", "Choose the expression that completes the sentence.", [target, "make a reservation", "take a shortcut", "keep in touch"], target),
    make(4, "Your friend suggests changing a plan to a later date.", `Which expression means ${meaning}?`, null, target),
    make(4, "You need to change a social plan and hope to meet later.", `Which expression means ${meaning}?`, null, target),
  ] };
}

afterEach(() => vi.unstubAllGlobals());

describe("practice exercise pool", () => {
  it("generates for a Word check word without an expressions row", async () => {
    const state = setup();
    const entry = starterSet().entries[0];
    const expressionId = newId();
    state.db.prepare(`INSERT INTO word_progress
      (expression_id, learner_id, text, normalized, source, status, band, rung, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'word_check', 'ready', ?, 2, ?, ?)`)
      .run(expressionId, state.learnerId, entry.text, normalizeWord(entry.text), entry.band, AT.toISOString(), AT.toISOString());
    const fetchMock = installResponse(starterBundle(entry.text, entry.definition));
    try {
      const exercise = await takePoolExercise(state.learnerId, expressionId, 1, {
        db: state.db, now: AT, config: state.config,
      });
      expect(exercise.expressionId).toBe(expressionId);
      expect(exercise.answer).toBe(entry.definition);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(request.messages[1].content).toContain(`<meaning>${entry.definition}</meaning>`);
      expect(state.db.prepare("SELECT COUNT(*) AS n FROM expressions WHERE learner_id = ? AND id = ?")
        .get(state.learnerId, expressionId)?.n).toBe(0);
      expect(state.db.prepare("SELECT COUNT(*) AS n FROM practice_exercise_pool WHERE learner_id = ? AND expression_id = ?")
        .get(state.learnerId, expressionId)?.n).toBe(7);
    } finally { state.cleanup(); }
  });

  it("generates once, reuses distinct rows, and reserves the explicit output budget", async () => {
    const state = setup();
    const fetchMock = installResponse(bundle());
    try {
      const first = await takePoolExercise(state.learnerId, state.expressionId, 1, { db: state.db, now: AT, config: state.config });
      const second = await takePoolExercise(state.learnerId, state.expressionId, 1, { db: state.db, now: AT, config: state.config });
      expect(first.sentence).not.toBe(second.sentence);
      expect(first.options).toHaveLength(4);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(request.max_tokens).toBe(4096);
      expect(request.response_format.json_schema.strict).toBe(true);
      expect(request.messages[1].content).toContain("<recent_sentences_json>[]</recent_sentences_json>");
      expect(state.db.prepare("SELECT kind, max_cost_micros, status FROM usage_reservations WHERE learner_id = ?").all(state.learnerId))
        .toEqual([expect.objectContaining({ kind: "detect", max_cost_micros: expect.any(Number), status: "settled" })]);
      expect(state.db.prepare("SELECT COUNT(*) AS n FROM practice_exercise_history WHERE learner_id = ?").get(state.learnerId)?.n).toBe(2);
    } finally { state.cleanup(); }
  });

  it("keeps a rung-independent history at the seven-day boundary after cache eviction", async () => {
    const state = setup();
    const fetchMock = installResponse(bundle());
    try {
      const first = await takePoolExercise(state.learnerId, state.expressionId, 1, { db: state.db, now: AT, config: state.config });
      const otherRung = state.db.prepare("SELECT id FROM practice_exercise_pool WHERE learner_id = ? AND expression_id = ? AND rung = 2 ORDER BY created_at LIMIT 1")
        .get(state.learnerId, state.expressionId);
      const cachedId = String(otherRung?.id ?? "missing");
      state.db.prepare("DELETE FROM practice_exercise_pool WHERE learner_id = ? AND expression_id = ? AND id != ?")
        .run(state.learnerId, state.expressionId, cachedId);
      state.db.prepare("UPDATE practice_exercise_pool SET sentence = ?, sentence_hash = ? WHERE learner_id = ? AND id = ?")
        .run(first.sentence, createHash("sha256").update(normalizeForMatch(first.sentence)).digest("hex"), state.learnerId, cachedId);
      // The independent history survives deletion of any corresponding cache row.
      state.db.prepare("DELETE FROM practice_exercise_pool WHERE learner_id = ? AND expression_id = ? AND id = ?")
        .run(state.learnerId, state.expressionId, cachedId);
      expect(state.db.prepare("SELECT sentence FROM practice_exercise_history WHERE learner_id = ?").get(state.learnerId)?.sentence).toBe(first.sentence);
      state.db.prepare(`INSERT INTO practice_exercise_pool (id, learner_id, expression_id, rung, sentence, sentence_hash, prompt, options_json, answer, hint, example, created_at)
        VALUES (?, ?, ?, 2, ?, ?, 'Choose the phrase.', ?, ?, 'Think about the situation.', ?, ?)`)
        .run(cachedId, state.learnerId, state.expressionId, first.sentence,
          createHash("sha256").update(normalizeForMatch(first.sentence)).digest("hex"), JSON.stringify([TARGET, "make a rain check", "take a short break", "keep an appointment"]), TARGET,
          `A friend said they would ${TARGET} after work.`, AT.toISOString());
      const boundary = new Date(AT.getTime() + 7 * 24 * 60 * 60 * 1000);
      fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(bundle("fresh")) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 200, cost: 0.001 },
      }), { status: 200 }));
      const atBoundary = await takePoolExercise(state.learnerId, state.expressionId, 2, { db: state.db, now: boundary, config: state.config });
      expect(atBoundary.sentence).not.toBe(first.sentence);
      const afterBoundary = await takePoolExercise(state.learnerId, state.expressionId, 2, { db: state.db, now: new Date(boundary.getTime() + 1), config: state.config });
      expect(afterBoundary.sentence).toBe(first.sentence);
      state.db.prepare("DELETE FROM practice_exercise_pool WHERE learner_id = ? AND expression_id = ?").run(state.learnerId, state.expressionId);
      expect(state.db.prepare("SELECT sentence FROM practice_exercise_history WHERE learner_id = ? AND sentence_hash = ?")
        .get(state.learnerId, createHash("sha256").update(normalizeForMatch(first.sentence)).digest("hex"))?.sentence).toBe(first.sentence);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { state.cleanup(); }
  });

  it("rejects cross-learner access and invalid duplicate output", async () => {
    const state = setup();
    const fetchMock = installResponse(bundle());
    const otherLearner = insertLearner(state.db, "judge");
    try {
      await expect(takePoolExercise(otherLearner, state.expressionId, 1, { db: state.db, now: AT, config: state.config })).rejects.toBeInstanceOf(NotFoundError);
      await takePoolExercise(state.learnerId, state.expressionId, 1, { db: state.db, now: AT, config: state.config });
      state.db.prepare("DELETE FROM practice_exercise_pool WHERE learner_id = ? AND expression_id = ?").run(state.learnerId, state.expressionId);
      const duplicateBundle = bundle("duplicate");
      duplicateBundle.exercises[2].sentence = (await state.db.prepare("SELECT sentence FROM practice_exercise_history WHERE learner_id = ? ORDER BY used_at LIMIT 1").get(state.learnerId))?.sentence as string;
      fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(duplicateBundle) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 100 },
      }), { status: 200 }));
      await expect(takePoolExercise(state.learnerId, state.expressionId, 2, { db: state.db, now: AT, config: state.config })).rejects.toBeInstanceOf(ModelOutputError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(state.db.prepare("SELECT COUNT(*) AS n FROM practice_exercise_history WHERE learner_id = ?").get(state.learnerId)?.n).toBe(1);
    } finally { state.cleanup(); }
  });

  it("enforces the per-call cap, kill switch, and detect quota before transport", async () => {
    const state = setup();
    const fetchMock = installResponse(bundle());
    try {
      await expect(takePoolExercise(state.learnerId, state.expressionId, 1, { db: state.db, now: AT, config: { ...state.config, practiceGenerationMaxCostMicros: 1 } })).rejects.toBeInstanceOf(BudgetExhaustedError);
      setAiEnabled(false, { db: state.db, now: AT, config: state.config });
      await expect(takePoolExercise(state.learnerId, state.expressionId, 1, { db: state.db, now: AT, config: state.config })).rejects.toBeInstanceOf(AiDisabledError);
      setAiEnabled(true, { db: state.db, now: AT, config: state.config });
      for (let i = 0; i < 30; i++) state.db.prepare(`INSERT INTO usage_reservations (id, learner_id, kind, request_id, units, max_cost_micros, actual_cost_micros, status, created_at)
        VALUES (?, ?, 'detect', ?, 1, 0, 0, 'settled', ?)`).run(newId(), state.learnerId, `prior-${i}`, AT.toISOString());
      await expect(takePoolExercise(state.learnerId, state.expressionId, 1, { db: state.db, now: AT, config: state.config })).rejects.toBeInstanceOf(QuotaExceededError);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.db.prepare("SELECT COUNT(*) AS n FROM usage_reservations WHERE learner_id = ? AND request_id LIKE 'practice-pool:%'").get(state.learnerId)?.n).toBe(0);
    } finally { state.cleanup(); }
  });
});
