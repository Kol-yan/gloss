import type { NextResponse } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/shared/contracts";

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

import * as continueModule from "@/app/join/[token]/continue/route";
import { POST } from "@/app/join/[token]/continue/route";
import { JoinCard } from "@/app/join/[token]/join-card";
import { createByokSession } from "@/server/auth/byok";
import { createInvite } from "@/server/auth/invites";
import { getSessionCookieName, SESSION_TTL_SECONDS } from "@/server/auth/sessions";
import { hashToken } from "@/server/auth/tokens";
import { db, installApp, seedExpression, session } from "./helpers/app";

installApp();

const SAME_ORIGIN = { "sec-fetch-site": "same-origin", origin: "http://localhost:3000" };

// The handler answers with a NextResponse (cookies API) or a plain 403 Response.
async function post(token: string, headers: Record<string, string> = SAME_ORIGIN, url?: string) {
  const requestUrl = url ?? `http://localhost:3000/join/${token}/continue`;
  return (await POST(
    new Request(requestUrl, { method: "POST", headers }),
    { params: Promise.resolve({ token }) },
  )) as NextResponse;
}
const cookieName = (url = "http://localhost:3000/") => getSessionCookieName(new Request(url));

const newInvite = (maxUses = 1) =>
  createInvite({ label: "Joiner", maxUses, quotaProfile: "judge" }).token;
const uses = (token: string) =>
  (db().prepare("SELECT uses FROM invites WHERE token_hash = ?").get(hashToken(token)) as { uses: number }).uses;
const learnerCount = () => (db().prepare("SELECT COUNT(*) AS n FROM learners").get() as { n: number }).n;

describe("POST /join/[token]/continue", () => {
  it("redeems, sets an httpOnly lax cookie and answers 303 home", async () => {
    const token = newInvite();
    const response = await post(token);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = response.cookies.get(cookieName());
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_SECONDS });
    expect(cookie?.secure).toBeFalsy();
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(uses(token)).toBe(1);
  });

  it("marks the cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect((await post(newInvite())).cookies.get(cookieName())?.secure).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("redirects invalid, used-up and malformed invites without a cookie", async () => {
    const token = newInvite(1);
    await post(token);
    for (const attempt of [token, "garbage", "z".repeat(43)]) {
      const response = await post(attempt);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/?invite=invalid");
      expect(response.cookies.get(cookieName())).toBeUndefined();
    }
  });

  it("is POST only", () => {
    expect(Object.keys(continueModule)).toEqual(["POST"]);
  });

  describe("same-origin check", () => {
    async function refused(headers: Record<string, string>, url?: string) {
      const token = newInvite();
      const before = learnerCount();
      const response = await post(token, headers, url);
      expect(response.status).toBe(403);
      expect(ApiError.parse(await response.json()).error.code).toBe("invalid_request");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(uses(token)).toBe(0);
      expect(learnerCount()).toBe(before);
    }

    it("refuses a cross-site POST, however the browser describes it", async () => {
      for (const site of ["cross-site", "same-site", "none"]) {
        await refused({ "sec-fetch-site": site, origin: "http://localhost:3000" });
      }
    });

    it("refuses a foreign or opaque Origin even without Sec-Fetch-Site", async () => {
      await refused({ origin: "https://evil.example" });
      await refused({ origin: "null" });
      await refused({ "sec-fetch-site": "same-origin", origin: "http://localhost:3001" });
      // Same host, other scheme.
      await refused({ origin: "https://localhost:3000" });
    });

    it("accepts the opaque Origin a no-referrer page sends on its own form post", async () => {
      const token = newInvite();
      expect((await post(token, { "sec-fetch-site": "same-origin", origin: "null" })).status).toBe(303);
      expect(uses(token)).toBe(1);
    });

    it("accepts a request with neither header (not a browser form post)", async () => {
      const token = newInvite();
      expect((await post(token, {})).status).toBe(303);
      expect(uses(token)).toBe(1);
    });

    it("accepts the origin the browser used behind a proxy", async () => {
      const token = newInvite();
      const response = await post(
        token,
        {
          "sec-fetch-site": "same-origin",
          origin: "https://glossy.example",
          "x-forwarded-host": "glossy.example",
          "x-forwarded-proto": "https",
        },
        "http://127.0.0.1:3000/join/x/continue",
      );
      expect(response.cookies.get(cookieName("http://127.0.0.1:3000/"))).toBeDefined();
      expect(uses(token)).toBe(1);
    });

    it("accepts the configured public URL", async () => {
      process.env.GLOSSY_PUBLIC_URL = "https://glossy.example";
      try {
        const token = newInvite();
        const response = await post(
          token,
          { "sec-fetch-site": "same-origin", origin: "https://glossy.example" },
          "http://internal:3000/join/x/continue",
        );
        expect(response.cookies.get(cookieName("http://internal:3000/"))).toBeDefined();
        // Another origin is still refused.
        await refused({ origin: "https://evil.example" }, "http://internal:3000/join/x/continue");
      } finally {
        delete process.env.GLOSSY_PUBLIC_URL;
      }
    });
  });

  describe("existing session", () => {
    it("does not spend a same-level invite for a signed-in learner", async () => {
      const first = await post(newInvite());
      session.cookie = first.cookies.get(cookieName())?.value;
      const learnersBefore = learnerCount();

      const second = newInvite();
      const response = await post(second);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
      expect(response.cookies.get(cookieName())?.value).toBe(session.cookie);
      expect(uses(second)).toBe(0);
      expect(learnerCount()).toBe(learnersBefore);
    });

    it("upgrades a BYOK learner in place and does not spend the invite twice", async () => {
      const learnersBefore = learnerCount();
      const visitor = createByokSession();
      session.cookie = visitor.sessionToken;
      seedExpression(visitor.learner.id);
      const token = newInvite();

      const response = await post(token);
      expect(response.cookies.get(cookieName())?.value).toBe(visitor.sessionToken);
      expect(db().prepare("SELECT id, quota_profile, funding_source FROM learners WHERE id = ?")
        .get(visitor.learner.id)).toEqual({ id: visitor.learner.id, quota_profile: "judge", funding_source: "byok" });
      expect(db().prepare("SELECT COUNT(*) AS n FROM expressions WHERE learner_id = ?")
        .get(visitor.learner.id)).toEqual({ n: 1 });
      expect(uses(token)).toBe(1);

      await post(token);
      expect(uses(token)).toBe(1);
      expect(learnerCount()).toBe(learnersBefore + 1);
    });

    it("redeems normally when the cookie is stale or garbage", async () => {
      for (const cookie of ["q".repeat(43), "nonsense"]) {
        session.cookie = cookie;
        const token = newInvite();
        expect((await post(token)).cookies.get(cookieName())?.value).toBeTruthy();
        expect(uses(token)).toBe(1);
      }
    });
  });
});

describe("the join page (GET /join/[token])", () => {
  const render = async (token: string) =>
    renderToStaticMarkup(await JoinCard({ params: Promise.resolve({ token }) }));

  it("offers a Continue button that posts to the continue route, and spends nothing", async () => {
    const token = newInvite();
    const before = learnerCount();
    const html = await render(token);

    expect(html).toMatch(new RegExp(`<form [^>]*action="/join/${token}/continue"`));
    expect(html).toMatch(/<form [^>]*method="post"/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Continue<\/button>/);
    expect(html).toContain("You are invited to");
    expect(html).toContain('<span class="brand-word">gloss</span>');
    expect(uses(token)).toBe(0);
    expect(learnerCount()).toBe(before);
    // Rendering twice (a preview bot, then the visitor) still spends nothing.
    await render(token);
    expect(uses(token)).toBe(0);
  });

  it("escapes whatever sits in the URL", async () => {
    const html = await render('"><script>alert(1)</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("%22%3E%3Cscript%3E");
  });

  it("offers a same-origin continue action when the browser is already signed in", async () => {
    const signedIn = await post(newInvite());
    session.cookie = signedIn.cookies.get(cookieName())?.value;
    const token = newInvite();
    const html = await render(token);

    expect(html).toContain("Add this invite to your workspace");
    expect(html).toMatch(new RegExp(`<form [^>]*action="/join/${token}/continue"`));
    expect(html).toMatch(/<form [^>]*method="post"/);
    expect(uses(token)).toBe(0);
  });
});
