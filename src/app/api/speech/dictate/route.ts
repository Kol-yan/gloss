import { DictationResponse } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { BodyTooLargeError, readBoundedBody } from "@/server/bounded-body";
import { dictate } from "@/server/dictation/service";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { providerAccessFromRequest } from "@/server/models/access";
import { MAX_WAV_BYTES } from "@/server/practice/wav";

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

    let audio: Uint8Array;
    try {
      const body = await readBoundedBody(request, MAX_BODY_BYTES);
      const form = await new Response(body as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": contentType },
      }).formData();
      const file = form.get("audio");
      if (!(file instanceof Blob)) return jsonError("invalid_request");
      if (file.size > MAX_WAV_BYTES) return jsonError("invalid_request", 413);
      audio = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (error instanceof BodyTooLargeError) return jsonError("invalid_request", 413);
      return jsonError("invalid_request");
    }

    return jsonOk(DictationResponse.parse(await dictate(learner, audio, {
      providerAccess: providerAccessFromRequest(request, learner),
    })));
  } catch (error) {
    return errorResponse(error);
  }
}
