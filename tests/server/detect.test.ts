import { describe, expect, it } from "vitest";
import { hashText } from "@/lib/text";
import { DetectResponse } from "@/shared/contracts";
import { getQuotaUsage, reserve, setAiEnabled } from "@/server/budget";
import { getConfig } from "@/server/config";
import { detect } from "@/server/detect/service";
import { parseDetectOutput } from "@/server/detect/schema";
import { AiDisabledError, BudgetExhaustedError, ConflictError, InvalidRequestError } from "@/server/errors";
import { ModelTimeoutError } from "@/server/models/errors";
import {
  db,
  fetchMock,
  installApp,
  login,
  requestId,
} from "./helpers/app";

installApp();

function providerReply(
  sentences: unknown[],
  usage: Record<string, unknown> = { prompt_tokens: 120, completion_tokens: 32, cost: 0.000123 },
  provider = "Nebius",
) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ sentences }) }, finish_reason: "stop" }],
    usage,
    provider,
  }), { status: 200 });
}

async function inputFor(text: string, overrides: { requestId?: string; localRanges?: { start: number; end: number }[] } = {}) {
  return {
    requestId: overrides.requestId ?? requestId(),
    sentences: [{
      hash: await hashText(text.normalize("NFC").replace(/\r\n?/g, "\n")),
      text,
      ...(overrides.localRanges === undefined ? {} : { localRanges: overrides.localRanges }),
    }],
  };
}

function decision(index = 0, values: Partial<{
  needs_correction: number;
  needs_clarity: number;
  needs_word_choice: number;
}> = {}) {
  return {
    sentence_index: index,
    needs_correction: values.needs_correction ?? 0.2,
    needs_clarity: values.needs_clarity ?? 0.3,
    needs_word_choice: values.needs_word_choice ?? 0.4,
  };
}

describe("sentence detector service", () => {
  it("rejects bad hashes and invalid UTF-16 range boundaries before reserving", async () => {
    const { learner } = login();
    const badHash = await inputFor("All good.");
    badHash.sentences[0].hash = "0".repeat(64);
    await expect(detect(learner, badHash)).rejects.toBeInstanceOf(InvalidRequestError);

    const emojiText = "A 😀 sentence.";
    const emojiInput = await inputFor(emojiText, { localRanges: [{ start: 3, end: 4 }] });
    await expect(detect(learner, emojiInput)).rejects.toBeInstanceOf(InvalidRequestError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db().prepare("SELECT COUNT(*) AS n FROM usage_reservations").get()).toEqual({ n: 0 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM detect_runs").get()).toEqual({ n: 0 });
  });

  it("validates sentence limits after normalization and rejects duplicate hashes", async () => {
    const { learner } = login();
    const tooLong = await inputFor("a".repeat(6001) + ".");
    await expect(detect(learner, tooLong)).rejects.toBeInstanceOf(InvalidRequestError);

    const same = await inputFor("Same sentence.");
    const duplicate = { ...same, sentences: [same.sentences[0], same.sentences[0]] };
    await expect(detect(learner, duplicate)).rejects.toBeInstanceOf(InvalidRequestError);

    const multiple = await inputFor("First sentence. Second sentence.");
    await expect(detect(learner, multiple)).rejects.toBeInstanceOf(InvalidRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db().prepare("SELECT COUNT(*) AS n FROM usage_reservations").get()).toEqual({ n: 0 });
  });

  it("blocks reservation when the runtime kill switch or hosted ceiling is closed", async () => {
    const { learner } = login();
    const input = await inputFor("A blocked detector request.");

    setAiEnabled(false);
    await expect(detect(learner, input)).rejects.toBeInstanceOf(AiDisabledError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db().prepare("SELECT 1 FROM usage_reservations WHERE request_id = ?").get(input.requestId)).toBeUndefined();
    expect(db().prepare("SELECT 1 FROM detect_runs WHERE request_id = ?").get(input.requestId)).toBeUndefined();

    setAiEnabled(true);
    const zeroCeiling = { ...getConfig(), dailyBudgetMicros: 0 };
    await expect(detect(learner, input, { config: zeroCeiling })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db().prepare("SELECT 1 FROM usage_reservations WHERE request_id = ?").get(input.requestId)).toBeUndefined();
    expect(db().prepare("SELECT 1 FROM detect_runs WHERE request_id = ?").get(input.requestId)).toBeUndefined();
  });

  it("reserves the fast role before calling the provider and stores hash-only results with audit data", async () => {
    const { learner } = login();
    const input = await inputFor("I has a sentence.", { localRanges: [{ start: 4, end: 7 }, { start: 2, end: 5 }] });
    let duringCall: Record<string, unknown> | undefined;
    fetchMock.mockImplementationOnce(async () => {
      duringCall = db().prepare(
        "SELECT status, kind, actual_cost_micros FROM usage_reservations WHERE request_id = ?",
      ).get(input.requestId) as Record<string, unknown>;
      return providerReply([decision()]);
    });

    const response = DetectResponse.parse(await detect(learner, input));
    expect(response.sentences).toEqual([{
      hash: input.sentences[0].hash,
      needs_correction: 0.2,
      needs_clarity: 0.3,
      needs_word_choice: 0.4,
    }]);
    expect(response.quota.used).toBe(1);
    expect(duringCall).toEqual({ status: "reserved", kind: "detect", actual_cost_micros: null });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.model).toBe("openai/gpt-oss-120b");
    expect(sent.max_tokens).toBe(2048);
    expect(sent.response_format.json_schema.strict).toBe(true);
    expect(sent.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(sent.messages[0].content).toMatch(/ignore those spans/);
    expect(sent.messages[1].content).toContain('"local_ranges":[{"start":2,"end":7}]');
    expect(sent.messages[1].content).not.toContain(input.sentences[0].hash);

    expect(db().prepare("SELECT * FROM usage_reservations WHERE request_id = ?").get(input.requestId)).toMatchObject({
      kind: "detect",
      status: "settled",
      actual_cost_micros: 123,
    });
    expect(db().prepare("SELECT * FROM detect_runs WHERE request_id = ?").get(input.requestId)).toMatchObject({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      provider: "openrouter",
      model: "openai/gpt-oss-120b",
      status: "ok",
      serving_provider: "Nebius",
      settled_cost_micros: 123,
    });
    const stored = String((db().prepare("SELECT response_json FROM detect_runs WHERE request_id = ?").get(input.requestId) as { response_json: string }).response_json);
    expect(stored).not.toContain("I has a sentence.");
    expect(stored).toContain(input.sentences[0].hash);
  });

  it("charges detector operations to their own quota", async () => {
    const { learner } = login("pilot");
    reserve({
      learnerId: learner.id,
      kind: "proofread",
      requestId: requestId(),
      units: 20,
      maxCostMicros: 0,
    });
    const input = await inputFor("A separate detector operation.");
    fetchMock.mockResolvedValueOnce(providerReply([decision()]));

    const response = DetectResponse.parse(await detect(learner, input));

    expect(response.quota).toEqual({ used: 1, limit: 20 });
    expect(getQuotaUsage(learner)).toMatchObject({
      proofread: { used: 20, limit: 20 },
      detect: { used: 1, limit: 20 },
    });
  });

  it("keeps an unknown provider outcome charged and never calls again for that request id", async () => {
    const { learner } = login();
    const input = await inputFor("A sentence with uncertainty.");
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(detect(learner, input)).rejects.toBeInstanceOf(ModelTimeoutError);
    expect(db().prepare("SELECT status, actual_cost_micros FROM usage_reservations WHERE request_id = ?").get(input.requestId)).toMatchObject({
      status: "unknown",
      actual_cost_micros: null,
    });
    expect(db().prepare("SELECT status, settled_cost_micros FROM detect_runs WHERE request_id = ?").get(input.requestId)).toMatchObject({
      status: "unknown",
      settled_cost_micros: null,
    });
    await expect(detect(learner, input)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("settles a billed call whose output misses exact coverage or has an invalid probability", async () => {
    const { learner } = login();
    const input = await inputFor("A sentence that needs a decision.");
    fetchMock.mockResolvedValueOnce(providerReply([decision(0, { needs_clarity: 1.2 })]));

    await expect(detect(learner, input)).rejects.toThrow();
    expect(db().prepare("SELECT status, actual_cost_micros FROM usage_reservations WHERE request_id = ?").get(input.requestId)).toMatchObject({
      status: "settled",
      actual_cost_micros: 123,
    });
    expect(db().prepare("SELECT status, serving_provider, settled_cost_micros FROM detect_runs WHERE request_id = ?").get(input.requestId)).toMatchObject({
      status: "failed",
      serving_provider: "Nebius",
      settled_cost_micros: 123,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches by learner and request id, binds local ranges, and replays without another call", async () => {
    const first = login();
    const id = requestId();
    const input = await inputFor("This is a sentence.", {
      requestId: id,
      localRanges: [{ start: 3, end: 6 }, { start: 0, end: 4 }],
    });
    fetchMock.mockResolvedValueOnce(providerReply([decision(0, { needs_clarity: 0.8 })]));
    const one = DetectResponse.parse(await detect(first.learner, input));
    const equivalentOrder = await inputFor("This is a sentence.", {
      requestId: id,
      localRanges: [{ start: 0, end: 4 }, { start: 3, end: 6 }],
    });
    const replay = DetectResponse.parse(await detect(first.learner, equivalentOrder));
    expect(replay.sentences).toEqual(one.sentences);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const changedRanges = await inputFor("This is a sentence.", { requestId: id, localRanges: [{ start: 0, end: 3 }] });
    await expect(detect(first.learner, changedRanges)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = login();
    fetchMock.mockResolvedValueOnce(providerReply([decision(0, { needs_clarity: 0.1 })]));
    const separateLearner = DetectResponse.parse(await detect(second.learner, input));
    expect(separateLearner.sentences[0].needs_clarity).toBe(0.1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db().prepare("SELECT COUNT(*) AS n FROM detect_runs WHERE request_id = ?").get(id)).toEqual({ n: 2 });
  });

  it("allows only one provider call when identical requests race", async () => {
    const { learner } = login();
    const input = await inputFor("Two simultaneous copies of this sentence.");
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    let releaseProvider!: () => void;
    const providerResponse = new Promise<Response>((resolve) => {
      releaseProvider = () => resolve(providerReply([decision()]));
    });
    fetchMock.mockImplementationOnce(async () => {
      providerStarted();
      return providerResponse;
    });

    const first = detect(learner, input);
    await started;
    const duplicate = detect(learner, input);
    let duplicateError: unknown;
    try {
      await duplicate;
    } catch (error) {
      duplicateError = error;
    } finally {
      releaseProvider();
    }
    await expect(first).resolves.toMatchObject({ requestId: input.requestId });

    expect(duplicateError).toBeInstanceOf(ConflictError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db().prepare("SELECT COUNT(*) AS n FROM usage_reservations WHERE kind = 'detect' AND request_id = ?").get(input.requestId)).toEqual({ n: 1 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM detect_runs WHERE request_id = ?").get(input.requestId)).toEqual({ n: 1 });
  });

  it("requires exact indexed coverage and probabilities in range", () => {
    const valid = { sentences: [decision(1), decision(0)] };
    expect(parseDetectOutput(JSON.stringify(valid), 2)?.map((item) => item.sentence_index)).toEqual([0, 1]);
    expect(parseDetectOutput(JSON.stringify({ sentences: [decision(0)] }), 2)).toBeNull();
    expect(parseDetectOutput(JSON.stringify({ sentences: [decision(0), decision(0)] }), 2)).toBeNull();
    expect(parseDetectOutput(JSON.stringify({ sentences: [decision(0, { needs_word_choice: 1.01 })] }), 1)).toBeNull();
    expect(parseDetectOutput(JSON.stringify({ sentences: [decision(0, { needs_correction: -0.01 })] }), 1)).toBeNull();
  });
});
