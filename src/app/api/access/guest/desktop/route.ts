import { NextResponse } from "next/server";
import { requireEmptyAccessBody } from "@/server/auth/access-body";
import { createGuestSession, guestClientIpHash } from "@/server/auth/guest";
import { isSameOriginPost } from "@/server/auth/origin";
import { getSessionCookieName, SESSION_TTL_SECONDS } from "@/server/auth/sessions";
import { learnerStatus } from "@/server/auth/status";
import { guestAccessAvailability } from "@/server/auth/turnstile";
import { notifyGuestCreation } from "@/server/budget/alerts";
import { getConfig } from "@/server/config";
import { getDb } from "@/server/db";
import { RateLimitedError } from "@/server/errors";
import { errorResponse, jsonError } from "@/server/http";

// The desktop app creates the same guest learner as a first visit to the
// website, without Turnstile: it cannot show the widget. The same per-IP daily
// limit and the same owner spend caps still apply, and a reachable cap still
// refuses the new guest. The app sends an empty JSON body and persists the
// returned session across launches; enrollment is only needed without a session.

const UNAVAILABLE_MESSAGE = "Free guest access is unavailable right now. Add your own OpenRouter key in Settings to keep going.";

export async function POST(request: Request) {
  try {
    if (!isSameOriginPost(request)) return jsonError("invalid_request", 403);
    await requireEmptyAccessBody(request);
    const config = getConfig();
    const cookieName = getSessionCookieName(request);
    if (!guestAccessAvailability(config).available) {
      return jsonError("ai_disabled", 503, UNAVAILABLE_MESSAGE);
    }

    const now = new Date();
    const ipHash = guestClientIpHash(request, config);
    let redemption;
    try {
      redemption = createGuestSession(ipHash, { config, now, desktop: true });
    } catch (error) {
      if (error instanceof RateLimitedError) {
        const response = jsonError("rate_limited", 429, "Free guest access is busy or limited today. Please try later, or add your own OpenRouter key in Settings.");
        response.headers.set("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
        return response;
      }
      throw error;
    }

    notifyGuestCreation(getDb(), now, config);
    return setSessionCookie(learnerStatus(redemption.learner), redemption.sessionToken, cookieName);
  } catch (error) {
    return errorResponse(error);
  }
}

function setSessionCookie(body: unknown, token: string, name: string): NextResponse {
  const response = NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set({ name, value: token, httpOnly: true, sameSite: "lax",
    secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SECONDS });
  return response;
}
