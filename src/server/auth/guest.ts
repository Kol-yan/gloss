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

// Only the explicitly trusted Cloudflare header identifies a client. Unknown
// clients share a hashed bucket so missing headers cannot bypass enrollment limits.
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
  const clientIp = guestClientIp(request, config);
  return createHash("sha256").update(clientIp ?? "gloss:unknown-guest-client").digest("hex");
}

// Guest creation and the persistent per-UTC-day limit share one SQLite write
// transaction, so parallel requests and process restarts cannot mint extra quota.
export function createGuestSession(
  ipHash: string,
  deps: ServerDeps & { config: AppConfig },
): GuestRedemption {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const dayStart = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
  const nextDay = new Date(Date.parse(dayStart) + 24 * 60 * 60 * 1000).toISOString();
  const db = deps.db ?? getDb();

  return immediate((tx) => {
    const count = Number(tx.prepare(
      `SELECT COUNT(*) AS count FROM guest_enrollments
       WHERE ip_hash = ? AND created_at >= ? AND created_at < ?`,
    ).get(ipHash, dayStart, nextDay)?.count ?? 0);
    if (count >= deps.config.guestDailyIpLimit) throw new RateLimitedError();

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
