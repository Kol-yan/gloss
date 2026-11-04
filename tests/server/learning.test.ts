import { describe, expect, it, vi } from "vitest";
import { LearningResponse, WritingEvidenceResponse } from "@/shared/contracts";
vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);
import { POST as learningRoute } from "@/app/api/learning/route";
import { POST as writingRoute } from "@/app/api/expressions/writing/route";
import { POST as detectRoute } from "@/app/api/detect/route";
import { POST as proofreadRoute } from "@/app/api/proofread/route";
import { resolveLearningOutput } from "@/server/learning/service";
import { listExpressions } from "@/server/practice/expressions";
import { decideSuggestion } from "@/server/proofread/decisions";
import { hashText } from "@/lib/text";
import { LEARNING_ROLE } from "@/server/models/roles";
import { chatReply, db, fetchMock, installApp, login, postJson, proofreadReply, requestId, seedExpression, sentBody, session } from "./helpers/app";

installApp();
const text = "This delay slows progress.";
const input = () => ({ requestId: requestId(), text });

describe("separate Learning call", () => {
  it("requires authentication and valid bounded input before any model work", async () => {
    expect((await postJson(learningRoute, input())).status).toBe(401);
    login();
    for (const body of [{}, { ...input(), text: " " }, { ...input(), text: "x".repeat(6001) }, { ...input(), expressions: [] }]) {
      expect((await postJson(learningRoute, body)).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("makes no model call for an empty saved list", async () => {
    login();
    const response = await postJson(learningRoute, input());
    expect(response.status).toBe(200);
    expect(LearningResponse.parse(await response.json()).suggestions).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses fast tier, a bounded output and detect quota; persists normal Apply/Dismiss suggestions", async () => {
    const { learner } = login();
    const { expressionId } = seedExpression(learner.id, { text: "bottleneck", meaning: "A point that slows progress." });
    fetchMock.mockResolvedValueOnce(chatReply({ proposals: [{ expressionId, start: 5, end: 10, original: "delay", replacement: "bottleneck", reason: "A word from your list fits here." }] }));
    const body = input();
    const response = await postJson(learningRoute, body);
    expect(response.status).toBe(200);
    const result = LearningResponse.parse(await response.json());
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({ origin: "learning", original: "delay", replacement: "bottleneck", start: 5, end: 10, meaningChange: false });
    expect(sentBody().model).toBe("openai/gpt-oss-120b");
    expect(sentBody().max_tokens).toBeGreaterThanOrEqual(2048);
    expect(LEARNING_ROLE.tier).toBe("fast");
    expect(db().prepare("SELECT kind, max_cost_micros, status FROM usage_reservations WHERE learner_id = ?").get(learner.id)).toMatchObject({ kind: "detect", status: "settled", max_cost_micros: expect.any(Number) });
    expect(result.quota.used).toBe(1);
    const again = await postJson(learningRoute, body);
    expect(again.status).toBe(200);
    expect(LearningResponse.parse(await again.json())).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await postJson(proofreadRoute, body)).status).toBe(409);
    for (let i = 0; i < 2; i++) decideSuggestion(learner, result.suggestions[0].id, "accepted");
    expect(listExpressions(learner).expressions[0].entries.map((entry) => entry.kind)).toEqual(["assisted_use"]);
  });
  it("sends only the signed-in learner's newest 30 expressions and treats nothing fits as normal", async () => {
    const a = login();
    seedExpression(a.learner.id, { text: "private-other-word" });
    const b = login();
    for (let i = 0; i < 33; i++) seedExpression(b.learner.id, { text: `saved-word-${i}`, meaning: `meaning-${i}`, createdAt: new Date(2026, 0, i + 1).toISOString() });
    fetchMock.mockResolvedValueOnce(chatReply({ proposals: [] }));
    const response = await postJson(learningRoute, input());
    expect(LearningResponse.parse(await response.json()).suggestions).toEqual([]);
    const messages = sentBody().messages;
    const data = JSON.parse(messages[1].content);
    expect(data.text).toBe(text);
    expect(data.expressions).toHaveLength(30);
    expect(Object.keys(data.expressions[0]).sort()).toEqual(["id", "meaning", "text"]);
    expect(JSON.stringify(messages)).not.toContain("private-other-word");
    expect(messages[0].content).toContain("Nothing fits is the NORMAL answer");
    expect(messages[0].content).toContain("At most 2");
  });
  it("never adds the saved list to detection or proofreading", async () => {
    const { learner } = login();
    seedExpression(learner.id, { text: "private-vocabulary-marker" });
    fetchMock.mockResolvedValueOnce(chatReply({ sentences: [{ sentence_index: 0, needs_correction: 0, needs_clarity: 0, needs_word_choice: 0 }] }));
    await postJson(detectRoute, { requestId: requestId(), sentences: [{ text, hash: await hashText(text) }] });
    fetchMock.mockResolvedValueOnce(proofreadReply([]));
    expect((await postJson(proofreadRoute, input())).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) expect(JSON.stringify(sentBody(i).messages)).not.toContain("private-vocabulary-marker");
  });
  it("refuses Spark and opaque presets before reservation, and respects the kill switch", async () => {
    const { learner } = login();
    seedExpression(learner.id);
    for (const model of ["meta/muse-spark-1.3", "@preset/unknown-routing"]) {
      process.env.OPENROUTER_FAST_MODEL = model;
      process.env.OPENROUTER_FAST_PRICE_IN_PER_M = "1";
      process.env.OPENROUTER_FAST_PRICE_OUT_PER_M = "1";
      expect((await postJson(learningRoute, input())).status).toBe(503);
    }
    expect(db().prepare("SELECT COUNT(*) AS n FROM usage_reservations WHERE learner_id = ?").get(learner.id)).toEqual({ n: 0 });
    process.env.OPENROUTER_FAST_MODEL = "openai/gpt-oss-120b";
    process.env.AI_ENABLED = "false";
    expect((await postJson(learningRoute, input())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("charges unusable output and does not retry it with the same request id", async () => {
    const { learner } = login();
    seedExpression(learner.id);
    fetchMock.mockResolvedValueOnce(chatReply({ proposals: [{}, {}, {}] }));
    const body = input();
    expect((await postJson(learningRoute, body)).status).toBe(502);
    expect((await postJson(learningRoute, body)).status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db().prepare("SELECT status, actual_cost_micros FROM usage_reservations WHERE learner_id = ?").get(learner.id)).toMatchObject({ status: "settled", actual_cost_micros: expect.any(Number) });
  });
  it("rejects wrong spans, unknown expressions, forced additions and meaning changes", () => {
    const expression = { id: "e", text: "bottleneck", meaning: "A delay.", familiarity: "new" as const };
    const proposal = { expressionId: "e", start: 5, end: 10, original: "delay", replacement: "bottleneck", reason: "A natural fit." };
    const resolve = (p: unknown, t = text) => resolveLearningOutput(JSON.stringify({ proposals: [p] }), t, [expression]);
    expect(resolve(proposal)).toHaveLength(1);
    expect(resolve({ ...proposal, start: 4 })).toEqual([]);
    expect(resolve({ ...proposal, expressionId: "other" })).toEqual([]);
    expect(resolve({ ...proposal, replacement: "bottleneck with invented facts" })).toEqual([]);
    expect(resolve({ ...proposal, start: 5, end: 16, original: "not a delay" }, "It's not a delay.")).toEqual([]);
    expect(resolveLearningOutput('{"proposals":[{},{},{}]}', text, [expression])).toBeNull();
    expect(resolve({ ...proposal, start: 0, end: 1, original: "\ud83d" }, "\u{1f642} delay.")).toEqual([]);
  });
});

describe("independent real-writing evidence", () => {
  it("matches in code, records a distinct history kind once per expression/document and leaves practice untouched", async () => {
    const { learner } = login();
    const { expressionId } = seedExpression(learner.id, { text: "take off the table" });
    const body = { documentId: requestId(), text: "We took off the table.", assistedRanges: [] };
    for (let i = 0; i < 2; i++) {
      const response = await postJson(writingRoute, body);
      expect(response.status).toBe(200);
      expect(WritingEvidenceResponse.parse(await response.json()).expressionIds).toEqual([expressionId]);
    }
    const events = db().prepare("SELECT * FROM evidence_events WHERE learner_id = ?").all(learner.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "independent_writing", attempt_id: null, verdict: null, cue: null });
    expect(listExpressions(learner).expressions[0].entries[0].kind).toBe("independent_writing");
    expect(db().prepare("SELECT next_practice_at FROM expressions WHERE id = ?").get(expressionId)).toEqual({ next_practice_at: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("excludes accepted help and never reads or writes another learner's evidence", async () => {
    const a = login();
    seedExpression(a.learner.id, { text: "bottleneck" });
    const b = login();
    seedExpression(b.learner.id, { text: "take off the table" });
    const body = { documentId: requestId(), text: "bottlenecks", assistedRanges: [] };
    expect(WritingEvidenceResponse.parse(await (await postJson(writingRoute, body)).json()).expressionIds).toEqual([]);
    session.cookie = a.sessionToken;
    expect(WritingEvidenceResponse.parse(await (await postJson(writingRoute, { ...body, assistedRanges: [{ start: 0, end: 11 }] })).json()).expressionIds).toEqual([]);
    expect(db().prepare("SELECT COUNT(*) AS n FROM evidence_events WHERE kind = 'independent_writing' AND learner_id IN (?, ?)").get(a.learner.id, b.learner.id)).toEqual({ n: 0 });
  });
  it("requires authentication and validates ranges", async () => {
    const body = { documentId: requestId(), text: "bottleneck", assistedRanges: [] };
    expect((await postJson(writingRoute, body)).status).toBe(401);
    login();
    expect((await postJson(writingRoute, { ...body, assistedRanges: [{ start: 0, end: 20 }] })).status).toBe(400);
  });
});
