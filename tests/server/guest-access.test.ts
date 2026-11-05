import type { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, MeResponse } from "@/shared/contracts";

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);

import { GET as availabilityRoute, POST as guestRoute } from "@/app/api/access/guest/route";
import { POST as desktopGuestRoute } from "@/app/api/access/guest/desktop/route";
import { guestClientIpHash, createGuestSession } from "@/server/auth/guest";
import { getSessionCookieName, SESSION_TTL_SECONDS } from "@/server/auth/sessions";
import { getConfig } from "@/server/config";
import { RateLimitedError } from "@/server/errors";
import { getDb } from "@/server/db";
import { fetchMock, installApp, session } from "./helpers/app";

installApp();

function request(body: unknown = {}, port = 3000, ip?: string): Request {
  return new Request(`http://localhost:${port}/api/access/guest`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: `http://localhost:${port}`,
      "sec-fetch-site": "same-origin",
      ...(ip ? { "cf-connecting-ip": ip } : {}),
    },
  });
}

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("guest access", () => {
  beforeEach(() => {
    session.cookie = undefined;
    getDb().prepare("DELETE FROM sessions WHERE learner_id IN (SELECT id FROM learners WHERE quota_profile = 'guest')").run();
    getDb().prepare("DELETE FROM guest_enrollments").run();
    getDb().prepare("DELETE FROM learners WHERE quota_profile = 'guest'").run();
  });

  afterEach(() => {
    session.cookie = undefined;
  });

  it("reports availability without creating a learner on GET", async () => {
    const before = Number(getDb().prepare("SELECT COUNT(*) AS n FROM learners").get()?.n);
    const response = await availabilityRoute();

    expect(await response.json()).toEqual({ siteKey: null, available: true });
    expect(Number(getDb().prepare("SELECT COUNT(*) AS n FROM learners").get()?.n)).toBe(before);
    expect(Number(getDb().prepare("SELECT COUNT(*) AS n FROM guest_enrollments").get()?.n)).toBe(0);
  });

  it("creates a guest only on POST and returns a long-lived host-only session cookie", async () => {
    const req = request({}, 4321);
    const response = await guestRoute(req) as NextResponse;
    const body = MeResponse.parse(await response.json());
    const cookie = response.cookies.get(getSessionCookieName(req));

    expect(body).toMatchObject({
      accessMode: "hosted",
      learner: { displayName: "Guest" },
      quotas: {
        proofread: { used: 0, limit: 30 },
        detect: { used: 0, limit: 30 },
        evaluate: { used: 0, limit: 3 },
        asrSeconds: { used: 0, limit: 300 },
      },
    });
    expect(cookie).toMatchObject({ name: "glossy_session_4321", httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_SECONDS });
    expect(cookie?.secure).toBe(false);
    expect(response.headers.get("set-cookie")).not.toContain("Domain=");
    expect(getDb().prepare("SELECT quota_profile, funding_source FROM learners WHERE id = ?").get(body.learner.id))
      .toEqual({ quota_profile: "guest", funding_source: "hosted" });
    expect(getDb().prepare("SELECT id, ip_hash FROM guest_enrollments WHERE id = ?").get(body.learner.id))
      .toMatchObject({ id: body.learner.id });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the same learner on an authenticated repeat POST", async () => {
    const first = await guestRoute(request());
    const original = MeResponse.parse(await first.json());
    session.cookie = (first as NextResponse).cookies.get(getSessionCookieName(request()))?.value;

    const repeated = await guestRoute(request());
    expect(MeResponse.parse(await repeated.json()).learner.id).toBe(original.learner.id);
    expect(Number(getDb().prepare("SELECT COUNT(*) AS n FROM guest_enrollments").get()?.n)).toBe(1);
  });

  it("rejects cross-origin and unexpected request bodies without enrollment", async () => {
    const crossSite = request();
    crossSite.headers.set("origin", "https://other.example");
    crossSite.headers.set("sec-fetch-site", "cross-site");

    expect((await guestRoute(crossSite)).status).toBe(403);
    expect((await guestRoute(request({ unexpected: true }))).status).toBe(400);
    expect((await guestRoute(new Request("http://localhost:3000/api/access/guest", { method: "POST" }))).status).toBe(400);
    expect(Number(getDb().prepare("SELECT COUNT(*) AS n FROM guest_enrollments").get()?.n)).toBe(0);
  });

  it("fails closed when production guest access has no Turnstile keys", async () => {
    await withEnv({ NODE_ENV: "production", TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET_KEY: undefined }, async () => {
      const available = await availabilityRoute();
      expect(await available.json()).toEqual({ siteKey: null, available: false });

      const response = await guestRoute(request());
      expect(response.status).toBe(503);
      const error = ApiError.parse(await response.json());
      expect(error.error.code).toBe("ai_disabled");
      expect(error.error.message).toContain("Add your own OpenRouter key");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(Number(getDb().prepare("SELECT COUNT(*) AS n FROM guest_enrollments").get()?.n)).toBe(0);
    });
  });

  it("verifies Turnstile action and hostname before creating a production guest", async () => {
    await withEnv({
      NODE_ENV: "production",
      TURNSTILE_SITE_KEY: "public-site-key",
      TURNSTILE_SECRET_KEY: "server-secret",
      TURNSTILE_ACTION: "guest_access",
      TURNSTILE_HOSTNAME: "localhost",
      BYOK_TRUST_PROXY_HEADERS: "true",
    }, async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        success: true, action: "guest_access", hostname: "localhost",
      })));
      const response = await guestRoute(request({ turnstileToken: "valid-token" }, 3000, "192.0.2.11")) as NextResponse;
      expect(response.status).toBe(200);
      expect(response.cookies.get("glossy_session")?.secure).toBe(true);
      const siteverify = fetchMock.mock.calls[0];
      expect(siteverify[0]).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
      expect(JSON.parse(siteverify[1].body)).toEqual({
        secret: "server-secret", response: "valid-token", remoteip: "192.0.2.11",
      });
      expect(JSON.stringify(await availabilityRoute().then((value) => value.json()))).not.toContain("server-secret");
      expect(Number(getDb().prepare("SELECT COUNT(*) AS n FROM guest_enrollments").get()?.n)).toBe(1);
    });
  });

  it("rejects failed Siteverify, action or hostname results", async () => {
    await withEnv({
      NODE_ENV: "production",
      TURNSTILE_SITE_KEY: "public-site-key",
      TURNSTILE_SECRET_KEY: "server-secret",
      TURNSTILE_ACTION: "guest_access",
      TURNSTILE_HOSTNAME: "localhost",
    }, async () => {
      for (const verification of [
        { success: false },
        { success: true, action: "other_action", hostname: "localhost" },
        { success: true, action: "guest_access", hostname: "other.example" },
      ]) {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(verification)));
        const response = await guestRoute(request({ turnstileToken: "token" }));
        expect(response.status).toBe(403);
        expect(ApiError.parse(await response.json()).error.code).toBe("invalid_request");
      }
      expect(Number(getDb().prepare("SELECT COUNT(*) AS n FROM guest_enrollments").get()?.n)).toBe(0);
    });
  });

  it("enforces the persistent three-per-IP daily cap atomically", async () => {
    await withEnv({ BYOK_TRUST_PROXY_HEADERS: "true", GUEST_DAILY_IP_LIMIT: "3" }, async () => {
      const responses = await Promise.all(Array.from({ length: 5 }, () => guestRoute(request({}, 3000, "192.0.2.22"))));
      expect(responses.filter((response) => response.status === 200)).toHaveLength(3);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(2);
      expect(Number(getDb().prepare("SELECT COUNT(*) AS n FROM guest_enrollments").get()?.n)).toBe(3);
      const storedHashes = getDb().prepare("SELECT DISTINCT ip_hash FROM guest_enrollments").all() as { ip_hash: string }[];
      expect(storedHashes).toEqual([{ ip_hash: guestClientIpHash(request({}, 3000, "192.0.2.22"), getConfig()) }]);
      expect(storedHashes[0].ip_hash).not.toBe("192.0.2.22");
    });
  });

  it("tells a capped browser when the allowance returns", async () => {
    await withEnv({ BYOK_TRUST_PROXY_HEADERS: "true", GUEST_DAILY_IP_LIMIT: "1" }, async () => {
      await guestRoute(request({}, 3000, "192.0.2.44"));
      const capped = await guestRoute(request({}, 3000, "192.0.2.44"));
      expect(capped.status).toBe(429);
      const retryAfter = Number(capped.headers.get("retry-after"));
      // Never a zero or negative wait, and never more than a day.
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(86_400);
    });
  });

  it("groups IPv6 privacy addresses by /64 without changing IPv4 buckets", () => {
    const config = { ...getConfig(), byokTrustProxyHeaders: true };
    const hash = (ip: string) => guestClientIpHash(request({}, 3000, ip), config);
    expect(hash("2001:db8:abcd:1234::1")).toBe(hash("2001:0db8:abcd:1234:ffff::99"));
    expect(hash("2001:db8:abcd:1234::1")).not.toBe(hash("2001:db8:abcd:1235::1"));
    expect(hash("::ffff:192.0.2.1")).toBe(hash("::ffff:192.0.2.2"));
    expect(hash("192.0.2.1")).not.toBe(hash("192.0.2.2"));
  });

  it("uses one fail-closed bucket when the proxy IP header is not trusted", () => {
    const config = getConfig();
    const first = guestClientIpHash(request({}, 3000, "192.0.2.1"), config);
    const second = guestClientIpHash(request({}, 3000, "192.0.2.2"), config);
    expect(first).toBe(second);
  });

  it("resets the persistent IP cap at the next UTC day", () => {
    const config = getConfig();
    const ipHash = guestClientIpHash(request({}, 3000, "192.0.2.33"), { ...config, byokTrustProxyHeaders: true });
    const beforeMidnight = new Date("2026-11-03T23:59:00.000Z");
    for (let i = 0; i < 3; i++) createGuestSession(ipHash, { config, now: beforeMidnight });
    expect(() => createGuestSession(ipHash, { config, now: beforeMidnight })).toThrow(RateLimitedError);
    expect(() => createGuestSession(ipHash, { config, now: new Date("2026-11-04T00:00:00.000Z") })).not.toThrow();
  });
});

describe("desktop guest access", () => {
  beforeEach(() => {
    session.cookie = undefined;
    getDb().prepare("DELETE FROM sessions WHERE learner_id IN (SELECT id FROM learners WHERE quota_profile = 'guest')").run();
    getDb().prepare("DELETE FROM guest_enrollments").run();
    getDb().prepare("DELETE FROM learners WHERE quota_profile = 'guest'").run();
  });

  const desktopRequest = (ip?: string) => new Request("http://localhost:3000/api/access/guest/desktop", {
    method: "POST",
    body: "{}",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "sec-fetch-site": "same-origin",
      ...(ip ? { "cf-connecting-ip": ip } : {}),
    },
  });

  it("creates the same guest learner without Turnstile and keeps the IP limit", async () => {
    const response = await desktopGuestRoute(desktopRequest("198.51.100.7")) as NextResponse;
    expect(response.status).toBe(200);
    const body = MeResponse.parse(await response.json());
    expect(body).toMatchObject({ accessMode: "hosted", learner: { displayName: "Guest" } });
    expect(response.cookies.get(getSessionCookieName(desktopRequest()))).toMatchObject({ name: "glossy_session_3000", httpOnly: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps desktop enrollment globally across IPs and returns Retry-After", async () => {
    await withEnv({ BYOK_TRUST_PROXY_HEADERS: "true", DESKTOP_GUEST_HOURLY_LIMIT: "2" }, async () => {
      const responses = await Promise.all(["192.0.2.1", "192.0.2.2", "192.0.2.3"].map(ip => desktopGuestRoute(desktopRequest(ip))));
      expect(responses.map(r => r.status)).toEqual([200, 200, 429]);
      expect(Number(responses[2].headers.get("retry-after"))).toBeGreaterThan(0);
      expect(Number(getDb().prepare("SELECT COUNT(*) AS n FROM guest_enrollments").get()?.n)).toBe(2);
    });
  });

  it("does not count web enrollments toward the desktop global hourly cap", async () => {
    await withEnv({ BYOK_TRUST_PROXY_HEADERS: "true", DESKTOP_GUEST_HOURLY_LIMIT: "2" }, async () => {
      for (const ip of ["192.0.2.10", "192.0.2.11", "192.0.2.12"]) {
        expect((await guestRoute(request({}, 3000, ip))).status).toBe(200);
      }
      expect((await desktopGuestRoute(desktopRequest("198.51.100.10"))).status).toBe(200);
      expect((await desktopGuestRoute(desktopRequest("198.51.100.11"))).status).toBe(200);
      const capped = await desktopGuestRoute(desktopRequest("198.51.100.12"));
      expect(capped.status).toBe(429);
      const retryAfter = Number(capped.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(3_600);
      expect(getDb().prepare("SELECT source, COUNT(*) AS n FROM guest_enrollments GROUP BY source ORDER BY source").all())
        .toEqual([{ source: "desktop", n: 2 }, { source: "web", n: 3 }]);
    });
  });

  it.each([
    { family: "IPv4", addresses: ["192.0.2.20", "192.0.2.20", "192.0.2.20", "192.0.2.20"], other: "192.0.2.21" },
    { family: "IPv6 /64", addresses: ["2001:db8:20:1::1", "2001:db8:20:1::2", "2001:db8:20:1:ffff::3", "2001:db8:20:1::4"], other: "2001:db8:20:2::1" },
  ])("limits desktop guests per $family in a rolling hour while other networks remain available", async ({ addresses, other }) => {
    await withEnv({
      BYOK_TRUST_PROXY_HEADERS: "true",
      GUEST_DAILY_IP_LIMIT: "50",
      DESKTOP_GUEST_HOURLY_IP_LIMIT: undefined,
      DESKTOP_GUEST_HOURLY_LIMIT: "100",
    }, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-11-04T12:59:00.000Z"));
        for (const ip of addresses.slice(0, 3)) {
          expect((await desktopGuestRoute(desktopRequest(ip))).status).toBe(200);
        }
        // Crossing the wall-clock hour does not reset a rolling allowance.
        vi.setSystemTime(new Date("2026-11-04T13:01:00.000Z"));
        const capped = await desktopGuestRoute(desktopRequest(addresses[3]));
        expect(capped.status).toBe(429);
        const retryAfter = Number(capped.headers.get("retry-after"));
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(3_600);
        expect((await desktopGuestRoute(desktopRequest(other))).status).toBe(200);
        expect(Number(getDb().prepare("SELECT COUNT(*) AS n FROM guest_enrollments").get()?.n)).toBe(4);

        vi.setSystemTime(new Date("2026-11-04T13:59:01.000Z"));
        expect((await desktopGuestRoute(desktopRequest(addresses[3]))).status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("shares the IPv6 daily bucket with web enrollment", async () => {
    await withEnv({ BYOK_TRUST_PROXY_HEADERS: "true", GUEST_DAILY_IP_LIMIT: "1" }, async () => {
      expect((await guestRoute(request({}, 3000, "2001:db8:1:2::1"))).status).toBe(200);
      const blocked = await desktopGuestRoute(desktopRequest("2001:db8:1:2::2"));
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    });
  });

  it("still refuses a crossed origin and a non-empty body", async () => {
    const crossSite = desktopRequest();
    crossSite.headers.set("origin", "https://other.example");
    crossSite.headers.set("sec-fetch-site", "cross-site");
    expect((await desktopGuestRoute(crossSite)).status).toBe(403);
    expect((await desktopGuestRoute(new Request("http://localhost:3000/api/access/guest/desktop", {
      method: "POST",
      body: JSON.stringify({ unexpected: true }),
      headers: { "content-type": "application/json" },
    }))).status).toBe(400);
  });
});
