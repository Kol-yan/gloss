import { connection, NextResponse } from "next/server";
import { redeemInvite } from "@/server/auth/invites";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/server/auth/sessions";
import { InvalidInviteError } from "@/server/errors";

// Redeeming changes state, so browser prefetches must not spend an invite use.
function isPrefetch(request: Request): boolean {
  const purpose = [request.headers.get("sec-purpose"), request.headers.get("purpose")].join(" ");
  return /prefetch|prerender/i.test(purpose);
}

const NO_CONTENT = { status: 204, headers: { "Cache-Control": "no-store" } } as const;

// Link checkers send HEAD; answer without redeeming.
export async function HEAD() {
  return new NextResponse(null, NO_CONTENT);
}

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, {
    status: 307,
    headers: {
      // Relative on purpose: behind a proxy the request URL is not the public one.
      Location: location,
      "Cache-Control": "no-store",
      // The invite token is in this URL; keep it out of Referer headers.
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  // Request time only: this handler touches the database.
  await connection();

  if (isPrefetch(request)) return new NextResponse(null, NO_CONTENT);

  const { token } = await context.params;
  let redemption;
  try {
    redemption = redeemInvite(token);
  } catch (error) {
    if (error instanceof InvalidInviteError) return redirectTo("/?invite=invalid");
    throw error;
  }

  const response = redirectTo("/");
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
