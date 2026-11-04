import { PracticeSessionHintRequest, PracticeSessionHintResponse } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { getPracticeHint } from "@/server/practice/sessions";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const learner = await requireLearner();
    const { sessionId } = await context.params;
    let input: PracticeSessionHintRequest;
    try {
      input = PracticeSessionHintRequest.parse(await request.json());
    } catch {
      return jsonError("invalid_request");
    }
    return jsonOk(PracticeSessionHintResponse.parse(getPracticeHint(learner.id, sessionId, input.exerciseId)));
  } catch (error) {
    return errorResponse(error);
  }
}
