import { describe, expect, it, vi } from "vitest";
import { ApiError, CreateExpressionResponse, ExpressionsResponse } from "@/shared/contracts";

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);

import { GET as listRoute, POST as createRoute } from "@/app/api/expressions/route";
import { newId } from "@/server/ids";
import { db, installApp, login, postJson, seedExpression, session } from "./helpers/app";

installApp();

const create = (body: unknown) => postJson(createRoute, body);
const get = () => listRoute();

// A suggestion as the proofread route leaves it, in the requested state.
function seedSuggestion(
  learnerId: string,
  over: { status?: string; meaning?: string | null; replacement?: string } = {},
): string {
  const runId = newId();
  const id = newId();
  const d = db();
  d.prepare(
    `INSERT INTO check_runs
       (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
     VALUES (?, ?, ?, 'h', 10, 'meta', 'm', 'ok', ?)`,
  ).run(runId, learnerId, newId(), new Date().toISOString());
  d.prepare(
    `INSERT INTO suggestions
       (id, check_run_id, learner_id, "start", "end", original, replacement, category, reason,
        meaning_change, meaning, status)
     VALUES (?, ?, ?, 0, 4, 'x', ?, 'expression', 'r', 0, ?, ?)`,
  ).run(
    id,
    runId,
    learnerId,
    over.replacement ?? "get the ball rolling",
    "meaning" in over ? (over.meaning ?? null) : "start something",
    over.status ?? "accepted",
  );
  return id;
}

describe("POST /api/expressions", () => {
  it("creates an expression from an accepted suggestion and records assisted use", async () => {
    const { learner } = login();
    const suggestionId = seedSuggestion(learner.id);
    const response = await create({ suggestionId, familiarity: "known_unused" });

    expect(response.status).toBe(200);
    const { expression } = CreateExpressionResponse.parse(await response.json());
    expect(expression).toMatchObject({
      text: "get the ball rolling",
      meaning: "start something",
      familiarity: "known_unused",
    });
    expect(db().prepare("SELECT * FROM expressions WHERE id = ?").get(expression.id)).toMatchObject({
      learner_id: learner.id,
      suggestion_id: suggestionId,
      next_practice_at: null,
    });
    expect(db().prepare("SELECT * FROM evidence_events WHERE expression_id = ?").all(expression.id)).toEqual([
      expect.objectContaining({
        kind: "assisted_use",
        verdict: null,
        cue: null,
        attempt_id: null,
        hint_used: 0,
        transcript_edited: 0,
      }),
    ]);
  });

  it("is idempotent per suggestion", async () => {
    const { learner } = login();
    const suggestionId = seedSuggestion(learner.id);
    const first = CreateExpressionResponse.parse(
      await (await create({ suggestionId, familiarity: "new" })).json(),
    );
    const again = await create({ suggestionId, familiarity: "used" });
    expect(again.status).toBe(200);
    expect(CreateExpressionResponse.parse(await again.json())).toEqual(first);
    expect(db().prepare("SELECT COUNT(*) AS n FROM expressions WHERE learner_id = ?").get(learner.id)).toEqual({ n: 1 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM evidence_events WHERE learner_id = ?").get(learner.id)).toEqual({ n: 1 });
  });

  it("does not let a learner use another learner's suggestion", async () => {
    const owner = login();
    const suggestionId = seedSuggestion(owner.learner.id);
    const other = login();
    const response = await create({ suggestionId, familiarity: "new" });
    expect(response.status).toBe(404);
    expect(ApiError.parse(await response.json()).error.code).toBe("not_found");
    expect((await create({ suggestionId: "missing", familiarity: "new" })).status).toBe(404);
    const count = (id: string) =>
      db().prepare("SELECT COUNT(*) AS n FROM expressions WHERE learner_id = ?").get(id);
    expect(count(other.learner.id)).toEqual({ n: 0 });
    expect(count(owner.learner.id)).toEqual({ n: 0 });
  });

  it("requires an accepted suggestion with a meaning", async () => {
    const { learner } = login();
    for (const status of ["pending", "rejected", "stale"]) {
      const response = await create({ suggestionId: seedSuggestion(learner.id, { status }), familiarity: "new" });
      expect(response.status).toBe(409);
      expect(ApiError.parse(await response.json()).error.code).toBe("conflict");
    }
    for (const meaning of [null, "  "]) {
      const response = await create({
        suggestionId: seedSuggestion(learner.id, { meaning }),
        familiarity: "new",
      });
      expect(response.status).toBe(400);
      expect(ApiError.parse(await response.json()).error.code).toBe("invalid_request");
    }
    expect(
      db().prepare("SELECT COUNT(*) AS n FROM expressions WHERE learner_id = ?").get(learner.id),
    ).toEqual({ n: 0 });
  });

  it("requires a session and a valid body", async () => {
    expect((await create({ suggestionId: "x", familiarity: "new" })).status).toBe(401);
    login();
    for (const body of [{}, { suggestionId: "x" }, { suggestionId: "x", familiarity: "expert" }]) {
      expect((await create(body)).status).toBe(400);
    }
  });
});

describe("GET /api/expressions", () => {
  it("requires a session", async () => {
    expect((await get()).status).toBe(401);
  });

  it("lists the learner's expressions newest first with history and labels", async () => {
    const { learner } = login();
    const older = seedExpression(learner.id, {
      text: "older phrase",
      createdAt: "2026-01-01T10:00:00.000Z",
      nextPracticeAt: new Date(Date.now() + 3 * 86_400_000 + 3600_000).toISOString(),
    });
    const newer = seedExpression(learner.id, { text: "newer phrase", createdAt: "2026-02-01T10:00:00.000Z" });
    const due = seedExpression(learner.id, {
      text: "due phrase",
      createdAt: "2026-01-15T10:00:00.000Z",
      nextPracticeAt: "2026-01-16T00:00:00.000Z",
    });
    const d = db();
    const event = (expressionId: string, kind: string, verdict: string | null, cue: string | null, at: string) =>
      d
        .prepare(
          `INSERT INTO evidence_events
             (id, learner_id, expression_id, kind, verdict, cue, hint_used, transcript_edited, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`,
        )
        .run(newId(), learner.id, expressionId, kind, verdict, cue, at);
    event(older.expressionId, "assisted_use", null, null, "2026-01-01T10:00:00.000Z");
    event(older.expressionId, "written_attempt", "almost", "shown", new Date().toISOString());

    const response = await get();
    expect(response.status).toBe(200);
    const body = ExpressionsResponse.parse(await response.json());
    expect(body.expressions.map((e) => e.expression.text)).toEqual([
      "newer phrase",
      "due phrase",
      "older phrase",
    ]);

    const [neverPracticed, overdue, scheduled] = body.expressions;
    expect(neverPracticed).toMatchObject({ nextPracticeLabel: null, due: true, entries: [] });
    expect(overdue).toMatchObject({ nextPracticeLabel: "Now", due: true });
    expect(scheduled).toMatchObject({ nextPracticeLabel: "In 3 days", due: false });
    expect(scheduled.entries).toEqual([
      { kind: "written_attempt", verdict: "almost", cue: "shown", hintUsed: true, transcriptEdited: true, dayLabel: "Today" },
      { kind: "assisted_use", verdict: null, cue: null, hintUsed: true, transcriptEdited: true, dayLabel: "1 Jan" },
    ]);
    expect([newer.expressionId, due.expressionId].length).toBe(2);
  });

  it("never shows another learner's expressions", async () => {
    const a = login();
    seedExpression(a.learner.id, { text: "mine" });
    const b = login();
    seedExpression(b.learner.id, { text: "theirs" });
    const body = ExpressionsResponse.parse(await (await get()).json());
    expect(body.expressions.map((e) => e.expression.text)).toEqual(["theirs"]);

    session.cookie = a.sessionToken;
    const mine = ExpressionsResponse.parse(await (await get()).json());
    expect(mine.expressions.map((e) => e.expression.text)).toEqual(["mine"]);
  });
});
