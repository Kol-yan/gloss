import { describe, expect, it, vi } from "vitest";
import { ApiError, Expression, ExpressionsResponse } from "@/shared/contracts";

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);

import { POST as captureRoute } from "@/app/api/expressions/capture/route";
import { GET as listRoute } from "@/app/api/expressions/route";
import { db, fetchMock, installApp, login, postJson, seedExpression } from "./helpers/app";

installApp();

const capture = (body: unknown) => postJson(captureRoute, body);
const count = (table: string, learnerId: string) =>
  (db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE learner_id = ?`).get(learnerId) as { n: number }).n;

async function captured(body: unknown): Promise<{ expression: Expression; created: boolean }> {
  const response = await capture(body);
  expect(response.status).toBe(200);
  const json = await response.json();
  return { expression: Expression.parse(json.expression), created: json.created };
}

describe("POST /api/expressions/capture", () => {
  it("saves a selected word to My words without a model call or evidence", async () => {
    const { learner } = login();
    const { expression, created } = await captured({ text: "  serendipity\n" });

    expect(created).toBe(true);
    expect(expression).toMatchObject({ text: "serendipity", meaning: "", familiarity: "new", ipa: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(count("usage_reservations", learner.id)).toBe(0);
    expect(count("evidence_events", learner.id)).toBe(0);
    expect(db().prepare("SELECT provider, model, status FROM check_runs WHERE learner_id = ?").all(learner.id))
      .toEqual([{ provider: "capture", model: "none", status: "ok" }]);
    expect(db().prepare("SELECT category, status, original, replacement FROM suggestions WHERE learner_id = ?")
      .all(learner.id)).toEqual([
      { category: "expression", status: "accepted", original: "serendipity", replacement: "serendipity" },
    ]);

    const list = ExpressionsResponse.parse(await (await listRoute()).json());
    expect(list.expressions).toEqual([
      expect.objectContaining({ expression: expression, entries: [], due: true }),
    ]);
  });

  it("keeps one entry per word, ignoring case and spacing, and fills only an empty meaning", async () => {
    const { learner } = login();
    const first = await captured({ text: "Get the ball  rolling", familiarity: "known_unused" });
    expect(first.expression).toMatchObject({ text: "Get the ball rolling", familiarity: "known_unused" });

    const again = await captured({ text: "get THE ball rolling", meaning: "  start  something " });
    expect(again).toEqual({ created: false, expression: { ...first.expression, meaning: "start something" } });

    const kept = await captured({ text: "get the ball rolling", meaning: "another meaning" });
    expect(kept.expression.meaning).toBe("start something");
    expect(count("expressions", learner.id)).toBe(1);
    expect(count("check_runs", learner.id)).toBe(1);
  });

  it("finds expressions saved from the editor too", async () => {
    const { learner } = login();
    const seeded = seedExpression(learner.id, { text: "unlikely to happen", meaning: "not likely" });
    const { expression, created } = await captured({ text: "Unlikely to happen", meaning: "ignored" });
    expect(created).toBe(false);
    expect(expression).toMatchObject({ id: seeded.expressionId, meaning: "not likely" });
  });

  it("never shows or reuses another learner's words", async () => {
    const a = login();
    const mine = await captured({ text: "ubiquitous" });
    const b = login();
    const theirs = await captured({ text: "ubiquitous" });
    expect(theirs.created).toBe(true);
    expect(theirs.expression.id).not.toBe(mine.expression.id);
    expect(count("expressions", a.learner.id)).toBe(1);
    expect(count("expressions", b.learner.id)).toBe(1);
  });

  it("requires a session", async () => {
    const response = await capture({ text: "word" });
    expect(response.status).toBe(401);
    expect(ApiError.parse(await response.json()).error.code).toBe("unauthorized");
  });

  it("rejects text that is not a short word or phrase", async () => {
    const { learner } = login();
    for (const body of [
      {},
      { text: "" },
      { text: "   " },
      { text: "1234 ..." },
      { text: "a".repeat(81) },
      { text: "word", meaning: "m".repeat(201) },
      { text: "word", familiarity: "expert" },
      { text: "word", pageUrl: "https://example.com/" },
      { text: 42 },
    ]) {
      const response = await capture(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(ApiError.parse(await response.json()).error.code).toBe("invalid_request");
    }
    const huge = await captureRoute(new Request("http://localhost/api/test", {
      method: "POST",
      body: JSON.stringify({ text: "word", meaning: " ".repeat(5_000) }),
    }));
    expect(huge.status).toBe(400);
    expect(count("expressions", learner.id)).toBe(0);
  });

  it("accepts the length limit exactly", async () => {
    login();
    const text = "a".repeat(80);
    expect((await captured({ text })).expression.text).toBe(text);
  });
});
