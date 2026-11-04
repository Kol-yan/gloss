import { after } from "next/server";
import { PracticeSessionReadiness } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonOk } from "@/server/http";
import { providerAccessFromRequest } from "@/server/models/access";
import { continuePracticePreparation, hasPreparationWork, practiceSessionReadiness } from "@/server/practice/sessions";

export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const learner = await requireLearner();
    const { sessionId } = await context.params;
    const readiness = PracticeSessionReadiness.parse(practiceSessionReadiness(learner.id, sessionId));
    if (hasPreparationWork(learner.id, sessionId)) {
      const providerAccess = providerAccessFromRequest(request, learner);
      after(async () => continuePracticePreparation(learner.id, sessionId, providerAccess));
    }
    return jsonOk(readiness);
  } catch (error) {
    return errorResponse(error);
  }
}
