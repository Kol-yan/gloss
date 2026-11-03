import { describe, expect, it, vi } from "vitest";
import { DictationResponse } from "@/shared/contracts";

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);

import { POST as dictateRoute } from "@/app/api/speech/dictate/route";
import { DICTATION_CLEANUP_ROLE } from "@/server/models/roles";
import { parseCleanup } from "@/server/dictation/service";
import { chatReply, db, fetchMock, installApp, login, makeWav, sentBody, session } from "./helpers/app";

installApp();

async function upload(audio: Uint8Array | null) {
  const form = new FormData();
  if (audio !== null) form.append("audio", new Blob([audio as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "a.wav");
  const encoded = new Response(form);
  const body = new Uint8Array(await encoded.arrayBuffer());
  return dictateRoute(
    new Request("http://localhost/api/speech/dictate", {
      method: "POST",
      body,
      headers: {
        "content-type": encoded.headers.get("content-type") ?? "",
        "content-length": String(body.byteLength),
      },
    }),
  );
}

const asrReply = (transcript: string) =>
  new Response(JSON.stringify({ transcript, audioDurationMs: 2000 }), { status: 200 });

const reservations = (learnerId: string) =>
  db()
    .prepare("SELECT kind, status FROM usage_reservations WHERE learner_id = ? ORDER BY created_at, kind")
    .all(learnerId);

const spoken = "um so we need to to move the meeting to friday you know";

describe("POST /api/speech/dictate", () => {
  it("transcribes with Meta, tidies the text with a Meta text model and stores no text", async () => {
    const { learner } = login();
    fetchMock.mockResolvedValueOnce(asrReply(spoken));
    fetchMock.mockResolvedValueOnce(chatReply({ text: "So we need to move the meeting to Friday." }));

    const response = await upload(makeWav({ seconds: 2 }));

    expect(response.status).toBe(200);
    expect(DictationResponse.parse(await response.json())).toEqual({
      text: "So we need to move the meeting to Friday.",
      rawText: spoken,
      cleaned: true,
      durationSeconds: 2,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://meta.test/v1/asr/transcribe");
    const chat = sentBody(1);
    expect(chat.model).toBe("muse-spark-1.3");
    expect(chat.max_tokens).toBe(DICTATION_CLEANUP_ROLE.maxTokens);
    expect(chat.messages[1].content).toContain(spoken);
    expect(reservations(learner.id)).toEqual([
      { kind: "asrSeconds", status: "settled" },
      { kind: "proofread", status: "settled" },
    ]);
    expect(JSON.stringify(db().prepare("SELECT * FROM usage_reservations").all())).not.toContain("meeting");
  });

  it("returns the raw transcript when the clean-up adds a word that was not spoken", async () => {
    login();
    fetchMock.mockResolvedValueOnce(asrReply(spoken));
    fetchMock.mockResolvedValueOnce(chatReply({ text: "So we need to move the meeting to next Friday." }));

    const body = DictationResponse.parse(await (await upload(makeWav({ seconds: 2 }))).json());

    expect(body).toMatchObject({ text: spoken, rawText: spoken, cleaned: false });
  });

  it("returns the raw transcript when the text model fails", async () => {
    login();
    fetchMock.mockResolvedValueOnce(asrReply(spoken));
    fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

    const response = await upload(makeWav({ seconds: 2 }));

    expect(response.status).toBe(200);
    expect(DictationResponse.parse(await response.json())).toMatchObject({ text: spoken, cleaned: false });
  });

  it("skips the clean-up when nothing was heard", async () => {
    login();
    fetchMock.mockResolvedValueOnce(asrReply("  "));

    const body = DictationResponse.parse(await (await upload(makeWav({ seconds: 1 }))).json());

    expect(body).toEqual({ text: "", rawText: "", cleaned: false, durationSeconds: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a missing file, invalid audio and an anonymous visitor without any model call", async () => {
    login();
    expect((await upload(null)).status).toBe(400);
    expect((await upload(new TextEncoder().encode("not audio"))).status).toBe(400);
    session.cookie = undefined;
    expect((await upload(makeWav({ seconds: 2 }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseCleanup", () => {
  it("accepts dropped fillers and new punctuation", () => {
    expect(parseCleanup('{"text":"We met on Monday."}', "uh we met on monday")).toBe("We met on Monday.");
  });

  it("rejects added, translated or changed words and malformed output", () => {
    expect(parseCleanup('{"text":"We did not meet."}', "we met")).toBeNull();
    expect(parseCleanup('{"text":"We met twice."}', "we met")).toBeNull();
    expect(parseCleanup('{"text":"We met met."}', "we met")).toBeNull();
    expect(parseCleanup('{"text":"  "}', "we met")).toBeNull();
    expect(parseCleanup("We met.", "we met")).toBeNull();
  });
});
