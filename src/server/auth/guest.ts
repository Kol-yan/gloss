import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { AppConfig } from "../config";
import type { ServerDeps } from "../deps";
import { getDb, immediate } from "../db";
import { RateLimitedError } from "../errors";
import { newId } from "../ids";
import { SESSION_TTL_MS, type Learner } from "./sessions";
import { generateToken, hashToken } from "./tokens";

export interface GuestRedemption {
  learner: Learner;
  sessionToken: string;
  sessionExpiresAt: Date;
}

// Client identity for the enrollment cap. Forwarded headers count only behind
// a trusted proxy; everyone else shares one hashed bucket, which cannot be
// reset by dropping a header. Owner-funded spend stays bounded by the global
// ceilings either way, so the shared bucket is the fail-closed choice.
export function guestClientIp(request: Request, config: AppConfig): string | null {
  const candidate = config.byokTrustProxyHeaders
    ? request.headers.get("cf-connecting-ip")?.trim()
    : undefined;
  if (!candidate) return null;
  const version = isIP(candidate);
  if (version === 4) return candidate;
  if (version !== 6) return null;
  try {
    return new URL(`http://[${candidate}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

export function guestClientIpHash(request: Request, config: AppConfig): string {
  const rawIp = guestClientIp(request, config);
  // Group IPv6 privacy addresses by network; keep the full address for Siteverify.
  const clientIp = rawIp && isIP(rawIp) === 6 ? ipv6Network(rawIp) : rawIp;
  return createHash("sha256").update(clientIp ?? "gloss:unknown-guest-client").digest("hex");
}

function ipv6Network(ip: string): string {
  // URL normalization expands embedded IPv4 addresses into hexadecimal groups.
  const [left, right] = ip.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const groups = right !== undefined ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  return groups.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(":") + "::/64";
}

// Guest creation and the persistent per-UTC-day limit share one SQLite write
// transaction, so parallel requests and process restarts cannot mint extra quota.
export function createGuestSession(
  ipHash: string,
  deps: ServerDeps & { config: AppConfig; desktop?: boolean },
): GuestRedemption {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const dayStart = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
  const nextDay = new Date(Date.parse(dayStart) + 24 * 60 * 60 * 1000).toISOString();
  const db = deps.db ?? getDb();

  return immediate((tx) => {
    if (deps.desktop) {
      // Count all enrollments so switching entry points cannot evade the global cap.
      const since = new Date(now.getTime() - 3_600_000).toISOString();
      const recent = tx.prepare(
        "SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM guest_enrollments WHERE created_at > ?",
      ).get(since) as { count: number; oldest: string | null };
      if (recent.count >= deps.config.desktopGuestHourlyLimit) {
        throw new RateLimitedError(Math.max(1000, Date.parse(recent.oldest!) + 3_600_000 - now.getTime()));
      }
    }
    const count = Number(tx.prepare(
      `SELECT COUNT(*) AS count FROM guest_enrollments
       WHERE ip_hash = ? AND created_at >= ? AND created_at < ?`,
    ).get(ipHash, dayStart, nextDay)?.count ?? 0);
    // The rejection names the wait until tomorrow, so a retrying browser can
    // back off instead of failing the first visit for the rest of the day.
    if (count >= deps.config.guestDailyIpLimit) {
      throw new RateLimitedError(Math.max(1_000, Date.parse(nextDay) - now.getTime()));
    }

    const learner = {
      id: newId(),
      displayName: "Guest",
      quotaProfile: "guest" as const,
      fundingSource: "hosted" as const,
    };
    tx.prepare(
      `INSERT INTO learners (id, display_name, quota_profile, funding_source, created_at)
       VALUES (?, ?, 'guest', 'hosted', ?)`,
    ).run(learner.id, learner.displayName, nowIso);

    const sessionToken = generateToken();
    const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    tx.prepare(
      "INSERT INTO sessions (token_hash, learner_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ).run(hashToken(sessionToken), learner.id, nowIso, sessionExpiresAt.toISOString());
    tx.prepare(
      "INSERT INTO guest_enrollments (id, ip_hash, created_at) VALUES (?, ?, ?)",
    ).run(learner.id, ipHash, nowIso);
    tx.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso);

    return { learner, sessionToken, sessionExpiresAt };
  }, db);
}
