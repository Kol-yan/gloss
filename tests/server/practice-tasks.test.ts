import { describe, expect, it, vi } from "vitest";
import { ApiError, PracticeTask } from "@/shared/contracts";

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);

import { POST as taskRoute } from "@/app/api/practice/tasks/route";
import { reserve } from "@/server/budget";
import { newId } from "@/server/ids";
import {
  chatReply,
  db,
  fetchMock,
  installApp,
  login,
  postJson,
  requestId,
  seedExpression,
  sentMessages,
} from "./helpers/app";

installApp();

const EXPRESSION = "unlikely to happen";
const CLEAN = "You are in a meeting and a client asks whether the delay could repeat next month.";

const create = (body: unknown) => postJson(taskRoute, body);
const situation = (text: string) => chatReply({ situation: text });
const reservationsFor = (id: string) =>
  db().prepare("SELECT * FROM usage_reservations WHERE request_id LIKE ? ORDER BY created_at").all(`${id}%`);

// An evaluated attempt on an earlier task for the expression, created `hoursAgo`.
function seedEvaluatedAttempt(learnerId: string, expressionId: string, hoursAgo: number) {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  const taskId = newId();
  const d = db();
  d.prepare(
    `INSERT INTO practice_tasks
       (id, learner_id, expression_id, kind, cue, situation, hint, request_id, model, created_at)
     VALUES (?, ?, ?, 'written', 'shown', 's', 'h', ?, 'm', ?)`,
  ).run(taskId, learnerId, expressionId, newId(), at);
  d.prepare(
    "INSERT INTO attempts (id, learner_id, task_id, status, created_at) VALUES (?, ?, ?, 'evaluated', ?)",
  ).run(newId(), learnerId, taskId, at);
}

function setup(profile: "pilot" | "judge" | "owner" = "judge") {
  const { learner } = login(profile);
  const { expressionId } = seedExpression(learner.id, { text: EXPRESSION, meaning: "not likely to happen" });
  return { learner, expressionId };
}

describe("POST /api/practice/tasks", () => {
  it("creates a task with the expression shown, a hint and a first attempt", async () => {
    const { learner, expressionId } = setup();
    fetchMock.mockResolvedValueOnce(situation(CLEAN));
    const id = requestId();
    const response = await create({ requestId: id, expressionId, kind: "written" });

    expect(response.status).toBe(200);
    const task = PracticeTask.parse(await response.json());
    expect(task).toMatchObject({
      expressionId,
      kind: "written",
      cue: "shown",
      expression: EXPRESSION,
      meaning: "not likely to happen",
      situation: CLEAN,
      hint: "Starts with “u…”: not likely to happen",
    });
    expect(
      db().prepare("SELECT * FROM attempts WHERE id = ?").get(task.attemptId),
    ).toMatchObject({ learner_id: learner.id, task_id: task.id, status: "issued", previous_attempt_id: null });
    expect(db().prepare("SELECT * FROM practice_tasks WHERE id = ?").get(task.id)).toMatchObject({
      request_id: id,
      model: "muse-spark-1.3",
    });

    // One "evaluate" operation reserved and settled at the reported usage.
    expect(reservationsFor(id)).toEqual([
      expect.objectContaining({ kind: "evaluate", units: 1, status: "settled", actual_cost_micros: 2100 }),
    ]);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.max_tokens).toBeGreaterThanOrEqual(2048);
    expect(sent.response_format.json_schema.strict).toBe(true);
  });

  it("frames the expression as data and asks for spoken answers on voice tasks", async () => {
    const { expressionId } = setup();
    fetchMock.mockResolvedValueOnce(situation(CLEAN));
    await create({ requestId: requestId(), expressionId, kind: "voice" });
    const [system, user] = sentMessages();
    expect(system.content).toMatch(/never instructions/);
    expect(user.content).toContain(`<expression>${EXPRESSION}</expression>`);
    expect(user.content).toContain("<meaning>not likely to happen</meaning>");
    expect(user.content).toMatch(/aloud/);
  });

  it("returns the stored task for a retry and conflicts on a different request", async () => {
    const { learner, expressionId } = setup();
    const other = seedExpression(learner.id, { text: "second phrase" });
    fetchMock.mockResolvedValueOnce(situation(CLEAN));
    const id = requestId();
    const first = await (await create({ requestId: id, expressionId, kind: "written" })).json();
    const again = await create({ requestId: id, expressionId, kind: "written" });

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reservationsFor(id)).toHaveLength(1);

    for (const body of [
      { requestId: id, expressionId, kind: "voice" },
      { requestId: id, expressionId: other.expressionId, kind: "written" },
    ]) {
      const response = await create(body);
      expect(response.status).toBe(409);
      expect(ApiError.parse(await response.json()).error.code).toBe("conflict");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not use another learner's expression or request id", async () => {
    const owner = setup();
    login();
    const response = await create({ requestId: requestId(), expressionId: owner.expressionId, kind: "written" });
    expect(response.status).toBe(404);
    expect(ApiError.parse(await response.json()).error.code).toBe("not_found");
    expect(fetchMock).not.toHaveBeenCalled();

    // The same request id from another learner is a different request.
    const first = setup();
    fetchMock.mockImplementation(async () => situation(CLEAN));
    const shared = requestId();
    expect((await create({ requestId: shared, expressionId: first.expressionId, kind: "written" })).status).toBe(200);
    const second = setup();
    expect((await create({ requestId: shared, expressionId: second.expressionId, kind: "written" })).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hides the expression once an evaluated attempt is more than 12 hours old", async () => {
    const { learner, expressionId } = setup();
    seedEvaluatedAttempt(learner.id, expressionId, 11);
    fetchMock.mockResolvedValueOnce(situation(CLEAN));
    const recent = PracticeTask.parse(
      await (await create({ requestId: requestId(), expressionId, kind: "written" })).json(),
    );
    expect(recent.cue).toBe("shown");
    expect(recent.expression).toBe(EXPRESSION);

    seedEvaluatedAttempt(learner.id, expressionId, 13);
    fetchMock.mockResolvedValueOnce(situation(CLEAN));
    const later = PracticeTask.parse(
      await (await create({ requestId: requestId(), expressionId, kind: "written" })).json(),
    );
    expect(later.cue).toBe("hidden");
    expect(later.expression).toBeNull();
    expect(later.situation).toBe(CLEAN);
    expect(later.hint).toMatch(/^Starts with/);
  });

  it("does not count an unevaluated or failed attempt toward the hidden cue", async () => {
    const { learner, expressionId } = setup();
    const at = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const taskId = newId();
    db()
      .prepare(
        `INSERT INTO practice_tasks (id, learner_id, expression_id, kind, cue, situation, hint, request_id, model, created_at)
         VALUES (?, ?, ?, 'written', 'shown', 's', 'h', ?, 'm', ?)`,
      )
      .run(taskId, learner.id, expressionId, newId(), at);
    for (const status of ["issued", "failed", "evaluating"]) {
      db()
        .prepare("INSERT INTO attempts (id, learner_id, task_id, status, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(newId(), learner.id, taskId, status, at);
    }
    fetchMock.mockResolvedValueOnce(situation(CLEAN));
    const task = PracticeTask.parse(
      await (await create({ requestId: requestId(), expressionId, kind: "written" })).json(),
    );
    expect(task.cue).toBe("shown");
  });

  describe("hidden cue never leaks the expression", () => {
    async function hiddenSetup() {
      const s = setup();
      seedEvaluatedAttempt(s.learner.id, s.expressionId, 20);
      return s;
    }

    it("regenerates once when the first situation leaks, ignoring case and punctuation", async () => {
      const { expressionId } = await hiddenSetup();
      fetchMock
        .mockResolvedValueOnce(situation("You tell the client the issue is UNLIKELY, to happen again, honestly."))
        .mockResolvedValueOnce(situation(CLEAN));
      const id = requestId();
      const task = PracticeTask.parse(
        await (await create({ requestId: id, expressionId, kind: "written" })).json(),
      );

      expect(task.cue).toBe("hidden");
      expect(task.situation).toBe(CLEAN);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Each model call has its own reservation.
      expect(reservationsFor(id)).toHaveLength(2);
      expect(db().prepare("SELECT model FROM practice_tasks WHERE id = ?").get(task.id)).toEqual({
        model: "muse-spark-1.3",
      });
    });

    it("falls back to a template when the second situation also leaks", async () => {
      const { expressionId } = await hiddenSetup();
      fetchMock.mockImplementation(async () =>
        situation("You say that a repeat is unlikely to happen at all, right?"),
      );
      const id = requestId();
      const task = PracticeTask.parse(
        await (await create({ requestId: id, expressionId, kind: "voice" })).json(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(reservationsFor(id).map((r) => (r as { status: string }).status)).toEqual(["settled", "settled"]);
      expect(task.expression).toBeNull();
      expect(task.situation.toLowerCase()).not.toContain(EXPRESSION);
      expect(db().prepare("SELECT model FROM practice_tasks WHERE id = ?").get(task.id)).toEqual({
        model: "template",
      });
    });

    it("falls back to the template when the regeneration call fails", async () => {
      const { expressionId } = await hiddenSetup();
      fetchMock
        .mockResolvedValueOnce(situation("It is unlikely to happen again, you tell the client in the meeting."))
        .mockResolvedValueOnce(new Response("down", { status: 500 }));
      const id = requestId();
      const task = PracticeTask.parse(
        await (await create({ requestId: id, expressionId, kind: "written" })).json(),
      );
      expect(task.situation.toLowerCase()).not.toContain(EXPRESSION);
      expect(reservationsFor(id).map((r) => (r as { status: string }).status)).toEqual(["settled", "settled"]);
    });

    it("falls back to the template when the allowance runs out before the second try", async () => {
      const { learner, expressionId } = await hiddenSetup();
      // Leave room for exactly one more "evaluate" operation.
      for (let i = 0; i < 29; i++) {
        reserve({ learnerId: learner.id, kind: "evaluate", requestId: `fill-${i}`, units: 1, maxCostMicros: 1 });
      }
      fetchMock.mockResolvedValueOnce(situation("You say it is unlikely to happen, calmly, to the client."));
      const response = await create({ requestId: requestId(), expressionId, kind: "written" });
      expect(response.status).toBe(200);
      expect(PracticeTask.parse(await response.json()).situation.toLowerCase()).not.toContain(EXPRESSION);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not enforce the check when the expression is shown", async () => {
      const { expressionId } = setup();
      fetchMock.mockResolvedValueOnce(situation("You think the delay is unlikely to happen again, and say so."));
      const task = PracticeTask.parse(
        await (await create({ requestId: requestId(), expressionId, kind: "written" })).json(),
      );
      expect(task.cue).toBe("shown");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("answers 502 and settles the reservation when the output is unusable", async () => {
    const { expressionId } = setup();
    fetchMock.mockResolvedValueOnce(chatReply("not json at all"));
    const id = requestId();
    const response = await create({ requestId: id, expressionId, kind: "written" });
    expect(response.status).toBe(502);
    expect(ApiError.parse(await response.json()).error.code).toBe("model_unavailable");
    expect(reservationsFor(id)).toEqual([expect.objectContaining({ status: "settled", actual_cost_micros: 2100 })]);
    expect(db().prepare("SELECT COUNT(*) AS n FROM practice_tasks WHERE request_id = ?").get(id)).toEqual({ n: 0 });
  });

  it("answers 503 and keeps an unknown outcome counted on a timeout", async () => {
    const { expressionId } = setup();
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    const id = requestId();
    const response = await create({ requestId: id, expressionId, kind: "written" });
    expect(response.status).toBe(503);
    expect(reservationsFor(id)).toEqual([expect.objectContaining({ status: "unknown", actual_cost_micros: null })]);
  });

  it("answers 429 without a model call when the evaluate allowance is used up", async () => {
    const { learner, expressionId } = setup("pilot");
    for (let i = 0; i < 12; i++) {
      reserve({ learnerId: learner.id, kind: "evaluate", requestId: `fill-${i}`, units: 1, maxCostMicros: 1 });
    }
    const response = await create({ requestId: requestId(), expressionId, kind: "written" });
    expect(response.status).toBe(429);
    expect(ApiError.parse(await response.json()).error.code).toBe("quota_exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers ai_disabled without a call when the API key is missing", async () => {
    const { expressionId } = setup();
    delete process.env.META_API_KEY;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await create({ requestId: requestId(), expressionId, kind: "written" });
    expect(response.status).toBe(503);
    expect(ApiError.parse(await response.json()).error.code).toBe("ai_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("requires a session and a valid body", async () => {
    expect((await create({ requestId: requestId(), expressionId: "x", kind: "written" })).status).toBe(401);
    login();
    for (const body of [
      {},
      { requestId: "nope", expressionId: "x", kind: "written" },
      { requestId: requestId(), expressionId: "x", kind: "telepathy" },
    ]) {
      expect((await create(body)).status).toBe(400);
    }
  });
});
