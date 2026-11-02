import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { redeemInvite } from "@/server/auth/invites";
import { isSameOriginPost } from "@/server/auth/origin";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  findLearnerBySessionToken,
} from "@/server/auth/sessions";
import { InvalidInviteError } from "@/server/errors";
import { jsonError } from "@/server/http";

function see(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: {
      // Relative on purpose: behind a proxy the request URL is not the public one.
      Location: location,
      "Cache-Control": "no-store",
      // The invite token is in this URL; keep it out of Referer headers.
      "Referrer-Policy": "no-referrer",
    },
  });
}

// The form on /join/{token} posts here. Redeeming changes state, so it only
// happens on a same-origin POST (see isSameOriginPost) and never replaces a
// session the browser already has.
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  if (!isSameOriginPost(request)) return jsonError("invalid_request", 403);

  const { token } = await context.params;
  const store = await cookies();
  if (findLearnerBySessionToken(store.get(SESSION_COOKIE)?.value)) return see("/");

  let redemption;
  try {
    redemption = redeemInvite(token);
  } catch (error) {
    if (error instanceof InvalidInviteError) return see("/?invite=invalid");
    throw error;
  }

  const response = see("/");
  response.cookies.set({
    name: SESSION_COOKIE,
    value: redemption.sessionToken,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return response;
}
