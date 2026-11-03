import { DetectRequest, DetectResponse, MAX_DETECT_TOTAL_TEXT_LENGTH, type DetectRequest as DetectRequestType } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { detect } from "@/server/detect/service";
import { providerAccessFromRequest } from "@/server/models/access";

const MAX_BODY_CHARS = MAX_DETECT_TOTAL_TEXT_LENGTH * 16 + 20_000;

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();

    let input: DetectRequestType;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_CHARS) return jsonError("invalid_request");
      input = DetectRequest.parse(JSON.parse(raw));
    } catch {
      return jsonError("invalid_request");
    }

    return jsonOk(DetectResponse.parse(await detect(learner, input, {
      providerAccess: providerAccessFromRequest(request, learner),
    })));
  } catch (error) {
    return errorResponse(error);
  }
}
