import { SuggestionDecisionRequest, SuggestionDecisionResponse } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { decideSuggestion } from "@/server/proofread/decisions";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const learner = await requireLearner();
    const { id } = await context.params;

    let body: SuggestionDecisionRequest;
    try {
      body = SuggestionDecisionRequest.parse(await request.json());
    } catch {
      return jsonError("invalid_request");
    }

    // The client's textHash is not checked: the decision is recorded as given
    // and the client applies the edit locally.
    return jsonOk(SuggestionDecisionResponse.parse(decideSuggestion(learner, id, body.decision)));
  } catch (error) {
    return errorResponse(error);
  }
}
