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

// A real multipart upload, with the Content-Length a browser would send.
async function upload(attemptId: string | null, audio: Uint8Array | string | null) {
  const form = new FormData();
  if (attemptId !== null) form.append("attemptId", attemptId);
  if (audio !== null) {
    const bytes = typeof audio === "string" ? new TextEncoder().encode(audio) : audio;
    form.append("audio", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "a.wav");
  }
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type") ?? "";
  const body = new Uint8Array(await encoded.arrayBuffer());
  return transcribeRoute(
    new Request("http://localhost/api/speech/transcribe", {
      method: "POST",
      body,
      headers: { "content-type": contentType, "content-length": String(body.byteLength) },
    }),
  );
}

// A request whose body is a stream we can count, to prove it is not read in full.
function streamed(headers: Record<string, string>, chunkBytes = 64 * 1024) {
  const state = { pulls: 0, bytes: 0 };
  // highWaterMark 0: nothing is produced until the route actually reads.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls++;
        state.bytes += chunkBytes;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request("http://localhost/api/speech/transcribe", {
    method: "POST",
    body,
    headers: { "content-type": "multipart/form-data; boundary=x", ...headers },
    duplex: "half",
  } as RequestInit);
  return { request, state };
}

const asrReply = (body: unknown = { transcript: "hello there", audioDurationMs: 2000 }) =>
  new Response(JSON.stringify(body), { status: 200 });

function withTrailing(wav: Uint8Array, extra: number): Uint8Array {
  const out = new Uint8Array(wav.length + extra);
  out.set(wav);
  out.fill(7, wav.length);
  return out;
}

function withSecondDataChunk(wav: Uint8Array): Uint8Array {
  const second = new Uint8Array(8 + 32_000);
  second.set([0x64, 0x61, 0x74, 0x61]);
  new DataView(second.buffer).setUint32(4, 32_000, true);
  const out = new Uint8Array(wav.length + second.length);
  out.set(wav);
  out.set(second, wav.length);
  return out;
}

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
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBeNull();
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
    // 3 seconds reserved (2.4 rounded up) and settled at that reservation: 3 s * $0.003/min with the 1.25 safety margin.
    expect(reservations(learner.id)).toEqual([
      expect.objectContaining({ units: 3, status: "settled", actual_cost_micros: 188 }),
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

  it("settles at the full reservation whatever duration the provider reports", async () => {
    const { learner, attemptId } = voiceAttempt();
    fetchMock.mockResolvedValueOnce(asrReply({ transcript: "x", audioDurationMs: 200 }));
    await upload(attemptId, makeWav({ seconds: 2 }));
    expect(reservations(learner.id)).toEqual([
      expect.objectContaining({ units: 2, status: "settled", actual_cost_micros: 125 }),
    ]);

    // A longer report cannot raise the charge above the reservation, and is logged.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = voiceAttempt();
    fetchMock.mockResolvedValueOnce(asrReply({ transcript: "x", audioDurationMs: 99_000 }));
    await upload(second.attemptId, makeWav({ seconds: 2 }));
    expect(reservations(second.learner.id)).toEqual([
      expect.objectContaining({ units: 2, actual_cost_micros: 125 }),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/99000 ms for 2 reserved seconds/);
    warn.mockRestore();
  });

  it("sends only the validated samples in a fresh canonical file", async () => {
    const { attemptId } = voiceAttempt();
    fetchMock.mockResolvedValueOnce(asrReply());
    // A streaming encoder's placeholder size and one stray padding byte.
    const upload1 = makeWav({ seconds: 1 });
    new DataView(upload1.buffer).setUint32(40, 0xffffffff, true);
    const padded = new Uint8Array(upload1.length + 1);
    padded.set(upload1);
    await upload(attemptId, padded);

    const sent = new Uint8Array(await ((fetchMock.mock.calls[0][1].body as FormData).get("audio") as File).arrayBuffer());
    expect(sent.length).toBe(44 + 16_000 * 2);
    const view = new DataView(sent.buffer);
    expect(new TextDecoder().decode(sent.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 32_000);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(32_000);
  });

  describe("rejects unusable audio before paying for or sending anything", () => {
    const cases: [string, () => Uint8Array | string, number?][] = [
      ["stereo", () => makeWav({ channels: 2 })],
      ["44.1 kHz", () => makeWav({ sampleRate: 44_100 })],
      ["8-bit", () => makeWav({ bits: 8 })],
      ["float PCM", () => makeWav({ format: 3 })],
      ["too long", () => makeWav({ seconds: 61 })],
      ["too short", () => makeWav({ seconds: 0.3 })],
      ["over 3 MB", () => makeWav({ seconds: 80, sampleRate: 24_000 }), 413],
      ["trailing audio after the data chunk", () => withTrailing(makeWav({ seconds: 1 }), 16_000)],
      ["a second data chunk", () => withSecondDataChunk(makeWav({ seconds: 1 }))],
      ["garbage", () => "this is not audio, it is a sentence of plain text that is long enough"],
      ["empty", () => new Uint8Array(0)],
    ];
    for (const [name, make, status] of cases) {
      it(name, async () => {
        const { learner, attemptId } = voiceAttempt();
        const response = await upload(attemptId, make());
        expect(response.status).toBe(status ?? 400);
        expect(ApiError.parse(await response.json()).error.code).toBe("invalid_request");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(reservations(learner.id)).toHaveLength(0);
        expect(attemptRow(attemptId).status).toBe("issued");
      });
    }
  });

  describe("request body limits", () => {
    it("requires a Content-Length and does not read a chunked body", async () => {
      const { attemptId } = voiceAttempt();
      const { request, state } = streamed({});
      const response = await transcribeRoute(request);
      expect(response.status).toBe(400);
      expect(ApiError.parse(await response.json()).error.code).toBe("invalid_request");
      expect(state.pulls).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(attemptRow(attemptId).status).toBe("issued");
    });

    it("rejects a declared length over the cap without reading anything", async () => {
      voiceAttempt();
      const { request, state } = streamed({ "content-length": String(50 * 1024 * 1024) });
      const response = await transcribeRoute(request);
      expect(response.status).toBe(413);
      expect(ApiError.parse(await response.json()).error.code).toBe("invalid_request");
      expect(state.pulls).toBe(0);
    });

    it("stops reading a body that is longer than it declared", async () => {
      voiceAttempt();
      // Declares 1 KB, then streams without end: the reader must give up at the cap.
      const { request, state } = streamed({ "content-length": "1000" });
      const response = await transcribeRoute(request);
      expect(response.status).toBe(413);
      const cap = 3 * 1024 * 1024 + 64 * 1024;
      expect(state.bytes).toBeGreaterThan(cap);
      // It stopped within one chunk of the cap.
      expect(state.bytes).toBeLessThanOrEqual(cap + 64 * 1024);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a body that is not multipart", async () => {
      voiceAttempt();
      const response = await transcribeRoute(
        new Request("http://localhost/api/speech/transcribe", {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json", "content-length": "2" },
        }),
      );
      expect(response.status).toBe(400);
    });
  });

  it("rejects a missing attemptId or audio part", async () => {
    const { attemptId } = voiceAttempt();
    expect((await upload(null, makeWav())).status).toBe(400);
    expect((await upload(attemptId, null)).status).toBe(400);
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
