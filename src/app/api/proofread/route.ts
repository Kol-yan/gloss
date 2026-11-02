import { ProofreadRequest, ProofreadResponse } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { proofread } from "@/server/proofread/service";

// 6000 characters is at most ~24 KB as UTF-8; anything far beyond that is not
// a real request.
const MAX_BODY_CHARS = 100_000;

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();

    let input: ProofreadRequest;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_CHARS) return jsonError("invalid_request");
      input = ProofreadRequest.parse(JSON.parse(raw));
    } catch {
      return jsonError("invalid_request");
    }

    return jsonOk(ProofreadResponse.parse(await proofread(learner, input)));
  } catch (error) {
    return errorResponse(error);
  }
}
