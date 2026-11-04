import { MAX_TEXT_LENGTH, WritingEvidenceRequest, WritingEvidenceResponse } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { recordWriting } from "@/server/learning/service";

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();
    let input: WritingEvidenceRequest;
    try {
      const raw = await request.text();
      if (raw.length > MAX_TEXT_LENGTH * 64 + 1000) return jsonError("invalid_request");
      input = WritingEvidenceRequest.parse(JSON.parse(raw));
    } catch { return jsonError("invalid_request"); }
    return jsonOk(WritingEvidenceResponse.parse(recordWriting(learner, input)));
  } catch (error) { return errorResponse(error); }
}
