import { TranscribeResponse } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { transcribeAttempt } from "@/server/practice/speech";
import { MAX_WAV_BYTES } from "@/server/practice/wav";

// The multipart envelope adds a little to the audio itself.
const MAX_BODY_BYTES = MAX_WAV_BYTES + 64 * 1024;

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();

    // Refuse oversized bodies before they are buffered.
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return jsonError("invalid_request");

    let attemptId: string;
    let audio: Uint8Array;
    try {
      const form = await request.formData();
      const id = form.get("attemptId");
      const file = form.get("audio");
      if (typeof id !== "string" || !id || !(file instanceof Blob)) {
        return jsonError("invalid_request");
      }
      if (file.size > MAX_WAV_BYTES) return jsonError("invalid_request");
      attemptId = id;
      audio = new Uint8Array(await file.arrayBuffer());
    } catch {
      return jsonError("invalid_request");
    }

    return jsonOk(TranscribeResponse.parse(await transcribeAttempt(learner, attemptId, audio)));
  } catch (error) {
    return errorResponse(error);
  }
}
