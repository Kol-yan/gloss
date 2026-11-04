import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireEmptyAccessBody } from "@/server/auth/access-body";
import { endSession } from "@/server/auth/byok";
import { isSameOriginPost } from "@/server/auth/origin";
import { getSessionCookieName } from "@/server/auth/sessions";
import { errorResponse, jsonError } from "@/server/http";

export async function POST(request: Request) {
  try {
    if (!isSameOriginPost(request)) return jsonError("invalid_request", 403);
    await requireEmptyAccessBody(request);
    const cookieName = getSessionCookieName(request);
    const store = await cookies();
    endSession(store.get(cookieName)?.value);
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set({ name: cookieName, value: "", httpOnly: true, sameSite: "lax",
      secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
