import { requireLearner } from "@/server/auth/request";
import { learnerStatus } from "@/server/auth/status";
import { errorResponse, jsonOk } from "@/server/http";

export async function GET() {
  try {
    // Reads the session cookie first, which also keeps this out of prerendering.
    const learner = await requireLearner();
    const body = learnerStatus(learner);
    return jsonOk(body);
  } catch (error) {
    return errorResponse(error);
  }
}
