import { after } from "next/server";
import { PracticeSessionPrepareRequest, PracticeSessionReadiness } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { providerAccessFromRequest } from "@/server/models/access";
import { continuePracticePreparation, preparePracticeSession } from "@/server/practice/sessions";

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();
    let input: PracticeSessionPrepareRequest;
    try {
      input = PracticeSessionPrepareRequest.parse(await request.json());
    } catch {
      return jsonError("invalid_request");
    }
    const providerAccess = providerAccessFromRequest(request, learner);
    const readiness = PracticeSessionReadiness.parse(preparePracticeSession(learner, input));
    if (readiness.status === "preparing" || (readiness.status === "ready" && readiness.ready < readiness.total)) {
      after(async () => continuePracticePreparation(learner.id, readiness.sessionId, providerAccess));
    }
    return jsonOk(readiness);
  } catch (error) {
    return errorResponse(error);
  }
}
