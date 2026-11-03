import { TranscribeResponse } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { transcribeAttempt } from "@/server/practice/speech";
import { MAX_WAV_BYTES } from "@/server/practice/wav";
import { providerAccessFromRequest } from "@/server/models/access";
import { BodyTooLargeError, readBoundedBody } from "@/server/bounded-body";

// The multipart envelope adds a little to the audio itself.
const MAX_BODY_BYTES = MAX_WAV_BYTES + 64 * 1024;

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();

    // A declared length is required, so oversized uploads are refused before
    // a single byte is read; the stream is still counted while reading.
    const declared = request.headers.get("content-length");
    if (declared === null || !/^\d+$/.test(declared)) return jsonError("invalid_request");
    if (Number(declared) > MAX_BODY_BYTES) return jsonError("invalid_request", 413);
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^multipart\/form-data\s*;/i.test(contentType)) return jsonError("invalid_request");

    let attemptId: string;
    let audio: Uint8Array;
    try {
      const body = await readBoundedBody(request, MAX_BODY_BYTES);
      const form = await new Response(body as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": contentType },
      }).formData();
      const id = form.get("attemptId");
      const file = form.get("audio");
      if (typeof id !== "string" || !id || !(file instanceof Blob)) {
        return jsonError("invalid_request");
      }
      if (file.size > MAX_WAV_BYTES) return jsonError("invalid_request", 413);
      attemptId = id;
      audio = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (error instanceof BodyTooLargeError) return jsonError("invalid_request", 413);
      return jsonError("invalid_request");
    }

    return jsonOk(TranscribeResponse.parse(await transcribeAttempt(learner, attemptId, audio, {
      providerAccess: providerAccessFromRequest(request, learner),
    })));
  } catch (error) {
    return errorResponse(error);
  }
}
