import { isProviderKey, PROVIDER_KEY_MESSAGE } from "@/shared/provider-key";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireEmptyAccessBody } from "@/server/auth/access-body";
import { createByokSession, switchSessionToByok } from "@/server/auth/byok";
import { createEnrollmentLimiter } from "@/server/auth/enrollment-rate";
import { isSameOriginPost } from "@/server/auth/origin";
import { getSessionCookieName, SESSION_TTL_SECONDS } from "@/server/auth/sessions";
import { learnerStatus } from "@/server/auth/status";
import { getConfig } from "@/server/config";
import { errorResponse, jsonError } from "@/server/http";
import { PROVIDER_KEY_HEADER } from "@/server/models/access";

const limitEnrollments = createEnrollmentLimiter();

export async function POST(request: Request) {
  try {
    if (!isSameOriginPost(request)) return jsonError("invalid_request", 403);
    await requireEmptyAccessBody(request);
    if (!isProviderKey(request.headers.get(PROVIDER_KEY_HEADER) ?? "")) {
      return jsonError("invalid_request", 400, PROVIDER_KEY_MESSAGE);
    }
    const store = await cookies();
    const cookieName = getSessionCookieName(request);
    const currentToken = store.get(cookieName)?.value;
    const current = switchSessionToByok(currentToken);
    if (current && currentToken) {
      const response = NextResponse.json(learnerStatus(current.learner), { headers: { "Cache-Control": "no-store" } });
      response.cookies.set({ name: cookieName, value: currentToken, httpOnly: true,
        sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SECONDS });
      return response;
    }

    limitEnrollments(request, getConfig().byokTrustProxyHeaders);
    const { learner, sessionToken } = createByokSession();
    const response = NextResponse.json(learnerStatus(learner), { headers: { "Cache-Control": "no-store" } });
    response.cookies.set({ name: cookieName, value: sessionToken, httpOnly: true,
      sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SECONDS });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
