import { describe, expect, it, vi } from "vitest";
import { ApiError, TranscribeResponse } from "@/shared/contracts";

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);

import { POST as transcribeRoute } from "@/app/api/speech/transcribe/route";
import { getBudgetStatus, reserve } from "@/server/budget";
import {
  db,
  fetchMock,
  installApp,
  login,
  makeWav,
  seedExpression,
  seedTask,
} from "./helpers/app";

installApp();

function upload(attemptId: string | null, audio: Uint8Array | string | null) {
  const form = new FormData();
  if (attemptId !== null) form.append("attemptId", attemptId);
  if (audio !== null) {
    const bytes = typeof audio === "string" ? new TextEncoder().encode(audio) : audio;
    form.append("audio", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "a.wav");
  }
  return transcribeRoute(new Request("http://localhost/api/speech/transcribe", { method: "POST", body: form }));
}

const asrReply = (body: unknown = { transcript: "hello there", audioDurationMs: 2000 }) =>
  new Response(JSON.stringify(body), { status: 200 });

function voiceAttempt(profile: "pilot" | "judge" | "owner" = "judge") {
  const { learner } = login(profile);
  const { expressionId } = seedExpression(learner.id);
  return { learner, ...seedTask(learner.id, expressionId, { kind: "voice" }) };
}

const attemptRow = (id: string) =>
  db().prepare("SELECT * FROM attempts WHERE id = ?").get(id) as Record<string, unknown>;
const reservations = (learnerId: string) =>
  db().prepare("SELECT * FROM usage_reservations WHERE learner_id = ? AND kind = 'asrSeconds'").all(learnerId);

describe("POST /api/speech/transcribe", () => {
  it("sends the documented multipart request and stores only the transcript", async () => {
    const { learner, attemptId } = voiceAttempt();
    fetchMock.mockResolvedValueOnce(asrReply());
    const audio = makeWav({ seconds: 2.4 });
    const response = await upload(attemptId, audio);

    expect(response.status).toBe(200);
    expect(TranscribeResponse.parse(await response.json())).toEqual({
      attemptId,
      text: "hello there",
      durationSeconds: 2.4,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://meta.test/v1/asr/transcribe");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key", Accept: "application/json" });
    expect(init.headers["Content-Type"]).toBeUndefined();
    const form = init.body as FormData;
    const settings = form.get("request") as Blob;
    expect(settings.type).toBe("application/json");
    expect(JSON.parse(await settings.text())).toEqual({
      mode: "PUSH_TO_TALK",
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      languageBias: ["English"],
    });
    const sent = form.get("audio") as File;
    expect(sent.name).toBe("audio.wav");
    expect(sent.size).toBe(audio.byteLength);

    expect(attemptRow(attemptId)).toMatchObject({
      status: "transcribed",
      raw_transcript: "hello there",
      audio_seconds: 2.4,
      answer: null,
    });
    // 3 seconds reserved (2.4 rounded up), settled at the 2 seconds the provider reported.
    expect(reservations(learner.id)).toEqual([
      expect.objectContaining({ units: 3, status: "settled", actual_cost_micros: 100 }),
    ]);
    // Nothing in the database holds the audio bytes.
    expect(JSON.stringify(db().prepare("SELECT * FROM attempts WHERE id = ?").all(attemptId))).not.toMatch(/RIFF/);
  });

  it("accepts 24 kHz audio and an empty transcript", async () => {
    const { attemptId } = voiceAttempt();
    fetchMock.mockResolvedValueOnce(asrReply({ transcript: "", audioDurationMs: 1500 }));
    const response = await upload(attemptId, makeWav({ seconds: 1.5, sampleRate: 24_000 }));
    expect(response.status).toBe(200);
    expect(TranscribeResponse.parse(await response.json()).text).toBe("");
    expect(attemptRow(attemptId)).toMatchObject({ status: "transcribed", raw_transcript: "" });
  });

  it("allows recording again and keeps the latest transcript", async () => {
    const { learner, attemptId } = voiceAttempt();
    fetchMock
      .mockResolvedValueOnce(asrReply({ transcript: "first take", audioDurationMs: 1000 }))
      .mockResolvedValueOnce(asrReply({ transcript: "second take", audioDurationMs: 1000 }));
    await upload(attemptId, makeWav({ seconds: 1 }));
    await upload(attemptId, makeWav({ seconds: 1 }));
    expect(attemptRow(attemptId).raw_transcript).toBe("second take");
    expect(reservations(learner.id)).toHaveLength(2);
  });

  it("settles at the provider's reported duration, never above the reservation", async () => {
    const { learner, attemptId } = voiceAttempt();
    fetchMock.mockResolvedValueOnce(asrReply({ transcript: "x", audioDurationMs: 99_000 }));
    await upload(attemptId, makeWav({ seconds: 2 }));
    expect(reservations(learner.id)).toEqual([
      expect.objectContaining({ units: 2, actual_cost_micros: 100 }),
    ]);
  });

  describe("rejects unusable audio before paying for or sending anything", () => {
    const cases: [string, () => Uint8Array | string][] = [
      ["stereo", () => makeWav({ channels: 2 })],
      ["44.1 kHz", () => makeWav({ sampleRate: 44_100 })],
      ["8-bit", () => makeWav({ bits: 8 })],
      ["float PCM", () => makeWav({ format: 3 })],
      ["too long", () => makeWav({ seconds: 61 })],
      ["too short", () => makeWav({ seconds: 0.3 })],
      ["over 3 MB", () => makeWav({ seconds: 80, sampleRate: 24_000 })],
      ["garbage", () => "this is not audio, it is a sentence of plain text that is long enough"],
      ["empty", () => new Uint8Array(0)],
    ];
    for (const [name, make] of cases) {
      it(name, async () => {
        const { learner, attemptId } = voiceAttempt();
        const response = await upload(attemptId, make());
        expect(response.status).toBe(400);
        expect(ApiError.parse(await response.json()).error.code).toBe("invalid_request");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(reservations(learner.id)).toHaveLength(0);
        expect(attemptRow(attemptId).status).toBe("issued");
      });
    }
  });

  it("rejects a missing attemptId or audio part", async () => {
    const { attemptId } = voiceAttempt();
    expect((await upload(null, makeWav())).status).toBe(400);
    expect((await upload(attemptId, null)).status).toBe(400);
    const notMultipart = await transcribeRoute(
      new Request("http://localhost/api/speech/transcribe", { method: "POST", body: "{}" }),
    );
    expect(notMultipart.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks ownership first: another learner's attempt is not found", async () => {
    const { attemptId, learner } = voiceAttempt();
    login();
    const response = await upload(attemptId, makeWav());
    expect(response.status).toBe(404);
    expect(ApiError.parse(await response.json()).error.code).toBe("not_found");
    // Even invalid audio gets 404, not a hint that the attempt exists.
    expect((await upload(attemptId, "garbage")).status).toBe(404);
    expect((await upload("missing", makeWav())).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reservations(learner.id)).toHaveLength(0);
  });

  it("only accepts audio for a voice task in a fresh state", async () => {
    const { learner } = login();
    const { expressionId } = seedExpression(learner.id);
    const written = seedTask(learner.id, expressionId, { kind: "written" });
    const writtenResponse = await upload(written.attemptId, makeWav());
    expect(writtenResponse.status).toBe(400);

    const voice = seedTask(learner.id, expressionId, { kind: "voice" });
    for (const status of ["evaluating", "evaluated", "failed"]) {
      db().prepare("UPDATE attempts SET status = ? WHERE id = ?").run(status, voice.attemptId);
      const response = await upload(voice.attemptId, makeWav());
      expect(response.status).toBe(409);
      expect(ApiError.parse(await response.json()).error.code).toBe("conflict");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    expect((await upload("x", makeWav())).status).toBe(401);
  });

  it("answers 429 without a call when the audio seconds allowance is used up", async () => {
    const { learner, attemptId } = voiceAttempt("pilot");
    reserve({ learnerId: learner.id, kind: "asrSeconds", requestId: "fill", units: 179, maxCostMicros: 1 });
    const response = await upload(attemptId, makeWav({ seconds: 1.5 }));
    expect(response.status).toBe(429);
    expect(ApiError.parse(await response.json()).error.code).toBe("quota_exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(attemptRow(attemptId).status).toBe("issued");
  });

  it("charges nothing for a provider refusal and leaves the attempt ready", async () => {
    const { learner, attemptId } = voiceAttempt();
    fetchMock.mockResolvedValueOnce(new Response("bad audio detail", { status: 400 }));
    const response = await upload(attemptId, makeWav());
    expect(response.status).toBe(503);
    expect(ApiError.parse(await response.json()).error.code).toBe("model_unavailable");
    expect(reservations(learner.id)).toEqual([expect.objectContaining({ status: "settled", actual_cost_micros: 0 })]);
    expect(attemptRow(attemptId)).toMatchObject({ status: "issued", raw_transcript: null });
  });

  it("keeps an unknown outcome counted when the call times out", async () => {
    const { learner, attemptId } = voiceAttempt();
    const before = getBudgetStatus().spentMicros;
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    const response = await upload(attemptId, makeWav({ seconds: 2 }));
    expect(response.status).toBe(503);
    const [reservation] = reservations(learner.id) as { status: string; max_cost_micros: number }[];
    expect(reservation.status).toBe("unknown");
    expect(getBudgetStatus().spentMicros).toBe(before + reservation.max_cost_micros);
    expect(attemptRow(attemptId).status).toBe("issued");
  });

  it("settles at the full reservation when the answer has no transcript", async () => {
    const { learner, attemptId } = voiceAttempt();
    fetchMock.mockResolvedValueOnce(asrReply({ audioDurationMs: 1000 }));
    const response = await upload(attemptId, makeWav({ seconds: 2 }));
    expect(response.status).toBe(502);
    const [reservation] = reservations(learner.id) as { status: string; actual_cost_micros: number; max_cost_micros: number }[];
    expect(reservation).toMatchObject({ status: "settled" });
    expect(reservation.actual_cost_micros).toBe(reservation.max_cost_micros);
  });

  it("answers ai_disabled without reserving when the API key is missing", async () => {
    const { learner, attemptId } = voiceAttempt();
    delete process.env.META_API_KEY;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await upload(attemptId, makeWav());
    expect(response.status).toBe(503);
    expect(ApiError.parse(await response.json()).error.code).toBe("ai_disabled");
    expect(reservations(learner.id)).toHaveLength(0);
    vi.restoreAllMocks();
  });
});
