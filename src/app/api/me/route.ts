import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSessionCookieName, requireLearnerFromToken, renewSessionExpiry, SESSION_TTL_SECONDS } from "@/server/auth/sessions";
import { learnerStatus } from "@/server/auth/status";
import { errorResponse } from "@/server/http";

export async function GET(request: Request) {
  try {
    const cookieName = getSessionCookieName(request);
    const store = await cookies();
    const token = store.get(cookieName)?.value;
    const expiresAt = renewSessionExpiry(token);
    const learner = requireLearnerFromToken(token);
    const response = NextResponse.json(learnerStatus(learner), {
      headers: { "Cache-Control": "no-store" },
    });
    if (expiresAt && token) {
      response.cookies.set({ name: cookieName, value: token, httpOnly: true, sameSite: "lax",
        secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SECONDS });
    }
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
