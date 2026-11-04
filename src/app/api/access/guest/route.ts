import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createGuestSession, guestClientIpHash } from "@/server/auth/guest";
import { parseGuestAccessBody } from "@/server/auth/access-body";
import { isSameOriginPost } from "@/server/auth/origin";
import {
  findLearnerBySessionToken,
  getSessionCookieName,
  renewSessionExpiry,
  SESSION_TTL_SECONDS,
} from "@/server/auth/sessions";
import { guestAccessAvailability, verifyGuestTurnstile } from "@/server/auth/turnstile";
import { notifyGuestCreation } from "@/server/budget/alerts";
import { getConfig } from "@/server/config";
import { RateLimitedError } from "@/server/errors";
import { getDb } from "@/server/db";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { learnerStatus } from "@/server/auth/status";

const UNAVAILABLE_MESSAGE = "Free guest access is unavailable right now. Add your own OpenRouter key in Settings to keep going.";

export async function GET() {
  try {
    return jsonOk(guestAccessAvailability(getConfig()));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!isSameOriginPost(request)) return jsonError("invalid_request", 403);
    const { turnstileToken } = await parseGuestAccessBody(request);
    const config = getConfig();
    const cookieName = getSessionCookieName(request);
    const store = await cookies();
    const currentToken = store.get(cookieName)?.value;
    const current = findLearnerBySessionToken(currentToken);
    if (current && currentToken) {
      const renewed = renewSessionExpiry(currentToken);
      if (renewed) return setSessionCookie(learnerStatus(current), currentToken, cookieName);
    }

    if (!guestAccessAvailability(config).available) {
      return jsonError("ai_disabled", 503, UNAVAILABLE_MESSAGE);
    }
    if (!await verifyGuestTurnstile(turnstileToken, request, config)) {
      return jsonError("invalid_request", 403, "Please complete the security check and try again.");
    }

    const now = new Date();
    const ipHash = guestClientIpHash(request, config);
    let redemption;
    try {
      redemption = createGuestSession(ipHash, { config, now });
    } catch (error) {
      if (error instanceof RateLimitedError) {
        const response = jsonError("rate_limited", 429, "Free guest access is limited for today. Add your own OpenRouter key in Settings to keep going.");
        response.headers.set("Retry-After", String(Math.ceil(error.retryAfterMs / 1_000)));
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
