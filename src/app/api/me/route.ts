import { MeResponse } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { getBudgetStatus, getQuotaUsage } from "@/server/budget";
import { errorResponse, jsonOk } from "@/server/http";

export async function GET() {
  try {
    // Reads the session cookie first, which also keeps this out of prerendering.
    const learner = await requireLearner();
    const body = MeResponse.parse({
      learner: { id: learner.id, displayName: learner.displayName },
      aiEnabled: getBudgetStatus().aiAvailable,
      quotas: getQuotaUsage(learner),
    });
    return jsonOk(body);
  } catch (error) {
    return errorResponse(error);
  }
}
