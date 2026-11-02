import { TranscribeResponse } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { transcribeAttempt } from "@/server/practice/speech";
import { MAX_WAV_BYTES } from "@/server/practice/wav";
import { providerAccessFromRequest } from "@/server/models/access";

// The multipart envelope adds a little to the audio itself.
const MAX_BODY_BYTES = MAX_WAV_BYTES + 64 * 1024;

class BodyTooLargeError extends Error {}

// Reads the request body into memory, giving up as soon as it exceeds the
// cap. Content-Length alone is not trusted: a chunked or lying client could
// otherwise make the server buffer an unbounded body.
async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) throw new BodyTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

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
      const body = await readBoundedBody(request);
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
