import { LearningRequest, LearningResponse, MAX_TEXT_LENGTH } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { learning } from "@/server/learning/service";
import { providerAccessFromRequest } from "@/server/models/access";

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();
    let input: LearningRequest;
    try {
      const raw = await request.text();
      if (raw.length > MAX_TEXT_LENGTH * 8 + 1000) return jsonError("invalid_request");
      input = LearningRequest.parse(JSON.parse(raw));
    } catch { return jsonError("invalid_request"); }
    return jsonOk(LearningResponse.parse(await learning(learner, input, {
      providerAccess: providerAccessFromRequest(request, learner),
    })));
  } catch (error) { return errorResponse(error); }
}
