import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireEmptyAccessBody } from "@/server/auth/access-body";
import { createByokSession } from "@/server/auth/byok";
import { createEnrollmentLimiter } from "@/server/auth/enrollment-rate";
import { isSameOriginPost } from "@/server/auth/origin";
import { findLearnerBySessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/server/auth/sessions";
import { learnerStatus } from "@/server/auth/status";
import { getConfig } from "@/server/config";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { PROVIDER_KEY_HEADER, providerKey } from "@/server/models/access";

const limitEnrollments = createEnrollmentLimiter();

export async function POST(request: Request) {
  try {
    if (!isSameOriginPost(request)) return jsonError("invalid_request", 403);
    await requireEmptyAccessBody(request);
    providerKey(request.headers.get(PROVIDER_KEY_HEADER));
    const store = await cookies();
    const current = findLearnerBySessionToken(store.get(SESSION_COOKIE)?.value);
    if (current) return jsonOk(learnerStatus(current));

    limitEnrollments(request, getConfig().byokTrustProxyHeaders);
    const { learner, sessionToken } = createByokSession();
    const response = NextResponse.json(learnerStatus(learner), { headers: { "Cache-Control": "no-store" } });
    response.cookies.set({ name: SESSION_COOKIE, value: sessionToken, httpOnly: true,
      sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SECONDS });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
