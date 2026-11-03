import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextResponse } from "next/server";
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
import { POST as join } from "@/app/join/[token]/continue/route";
import { createInvite } from "@/server/auth/invites";
import { reserve, setAiEnabled } from "@/server/budget";
import { closeDb, getDb } from "@/server/db";

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "glossy-routes-"));
  for (const key of ["GLOSSY_DATABASE_PATH", "DAILY_BUDGET_USD", "AI_ENABLED", "OPENROUTER_API_KEY"]) {
    saved[key] = process.env[key];
  }
  process.env.GLOSSY_DATABASE_PATH = path.join(dir, "routes.db");
  process.env.DAILY_BUDGET_USD = "1";
  process.env.AI_ENABLED = "true";
  process.env.OPENROUTER_API_KEY = "sk-or-v1-" + "a".repeat(16);
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
  getDb().prepare("DELETE FROM usage_reservations").run();
  setAiEnabled(true);
});

// Redeems an invite the way the join page's form does.
const joinRequest = async (token: string) =>
  (await join(
    new Request(`http://localhost:3000/join/${token}/continue`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", origin: "http://localhost:3000" },
    }),
    { params: Promise.resolve({ token }) },
  )) as NextResponse;

function newInvite(maxUses = 1, profile: "pilot" | "judge" | "owner" = "judge") {
  return createInvite({ label: "Route test", maxUses, quotaProfile: profile }).token;
}

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
      detect: { used: 0, limit: 100 },
      evaluate: { used: 0, limit: 12 },
      asrSeconds: { used: 0, limit: 180 },
    });

    reserve({ learnerId: body.learner.id, kind: "detect", requestId: "detect-1", units: 1, maxCostMicros: 1000 });
    body = MeResponse.parse(await (await me()).json());
    expect(body.quotas.detect).toEqual({ used: 1, limit: 100 });

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

  it("disables hosted AI when the owner OpenRouter key is missing or invalid", async () => {
    const joined = await joinRequest(newInvite(1, "pilot"));
    sessionCookie = joined.cookies.get("glossy_session")?.value;
    const validKey = process.env.OPENROUTER_API_KEY;
    try {
      delete process.env.OPENROUTER_API_KEY;
      expect(MeResponse.parse(await (await me()).json()).aiEnabled).toBe(false);
      process.env.OPENROUTER_API_KEY = "invalid";
      expect(MeResponse.parse(await (await me()).json()).aiEnabled).toBe(false);
      process.env.OPENROUTER_API_KEY = validKey!;
      expect(MeResponse.parse(await (await me()).json()).aiEnabled).toBe(true);
    } finally {
      if (validKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = validKey;
    }
  });
});
