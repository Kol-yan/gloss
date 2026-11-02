import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, MeResponse } from "@/shared/contracts";

// The handlers run outside a Next request here, so the two request-scoped
// helpers are replaced; everything else (cookies, redirects, SQL) is real.
let sessionCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "glossy_session" && sessionCookie ? { name, value: sessionCookie } : undefined,
  }),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

import { GET as me } from "@/app/api/me/route";
import { GET as join, HEAD as joinHead } from "@/app/join/[token]/route";
import { createInvite } from "@/server/auth/invites";
import { reserve, setAiEnabled } from "@/server/budget";
import { closeDb, getDb } from "@/server/db";

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "glossy-routes-"));
  for (const key of ["GLOSSY_DATABASE_PATH", "DAILY_BUDGET_USD", "AI_ENABLED"]) {
    saved[key] = process.env[key];
  }
  process.env.GLOSSY_DATABASE_PATH = path.join(dir, "routes.db");
  process.env.DAILY_BUDGET_USD = "1";
  process.env.AI_ENABLED = "true";
});

afterAll(() => {
  closeDb();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  sessionCookie = undefined;
  setAiEnabled(true);
});

const joinRequest = (token: string, headers: Record<string, string> = {}) =>
  join(new Request(`http://localhost:3000/join/${token}`, { headers }), {
    params: Promise.resolve({ token }),
  });

function newInvite(maxUses = 1, profile: "pilot" | "judge" | "owner" = "judge") {
  return createInvite({ label: "Route test", maxUses, quotaProfile: profile }).token;
}

describe("GET /join/[token]", () => {
  it("redeems, sets an httpOnly lax cookie and redirects home", async () => {
    const response = await joinRequest(newInvite());
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.cookies.get("glossy_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 2_592_000 });
    expect(cookie?.secure).toBeFalsy();
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("marks the cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const response = await joinRequest(newInvite());
      expect(response.cookies.get("glossy_session")?.secure).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("redirects invalid, used-up and malformed invites without a cookie", async () => {
    const token = newInvite(1);
    await joinRequest(token);
    for (const attempt of [token, "garbage", "z".repeat(43)]) {
      const response = await joinRequest(attempt);
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("/?invite=invalid");
      expect(response.cookies.get("glossy_session")).toBeUndefined();
    }
  });

  it("does not spend an invite on HEAD or prefetch requests", async () => {
    const token = newInvite(1);
    expect((await joinHead()).status).toBe(204);
    const prefetch = await joinRequest(token, { "sec-purpose": "prefetch" });
    expect(prefetch.status).toBe(204);
    expect(prefetch.cookies.get("glossy_session")).toBeUndefined();
    expect((await joinRequest(token)).headers.get("location")).toBe("/");
  });
});

describe("GET /api/me", () => {
  it("answers 401 with an ApiError when there is no session", async () => {
    const response = await me();
    expect(response.status).toBe(401);
    const body = ApiError.parse(await response.json());
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message.length).toBeLessThan(100);
  });

  it("answers 401 for an unknown session token", async () => {
    sessionCookie = "q".repeat(43);
    expect((await me()).status).toBe(401);
  });

  it("returns quotas used today versus the limit", async () => {
    const joined = await joinRequest(newInvite(1, "pilot"));
    sessionCookie = joined.cookies.get("glossy_session")?.value;

    let body = MeResponse.parse(await (await me()).json());
    expect(body.learner.displayName).toBe("Route test 1");
    expect(body.aiEnabled).toBe(true);
    expect(body.quotas).toEqual({
      proofread: { used: 0, limit: 20 },
      evaluate: { used: 0, limit: 12 },
      asrSeconds: { used: 0, limit: 180 },
    });

    reserve({
      learnerId: body.learner.id,
      kind: "asrSeconds",
      requestId: "r1",
      units: 45,
      maxCostMicros: 1000,
    });
    body = MeResponse.parse(await (await me()).json());
    expect(body.quotas.asrSeconds).toEqual({ used: 45, limit: 180 });
  });

  it("reports aiEnabled false for the kill switch and for a spent ceiling", async () => {
    const joined = await joinRequest(newInvite(1, "owner"));
    sessionCookie = joined.cookies.get("glossy_session")?.value;
    const learnerId = MeResponse.parse(await (await me()).json()).learner.id;

    setAiEnabled(false);
    expect(MeResponse.parse(await (await me()).json()).aiEnabled).toBe(false);

    setAiEnabled(true);
    expect(MeResponse.parse(await (await me()).json()).aiEnabled).toBe(true);
    const spent = getDb()
      .prepare("SELECT COALESCE(SUM(max_cost_micros), 0) AS n FROM usage_reservations")
      .get();
    reserve({
      learnerId,
      kind: "proofread",
      requestId: "drain",
      units: 1,
      maxCostMicros: 1_000_000 - Number(spent?.n ?? 0),
    });
    expect(MeResponse.parse(await (await me()).json()).aiEnabled).toBe(false);
  });
});
