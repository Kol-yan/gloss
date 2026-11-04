import { QuotaProfileNameSchema, type QuotaProfileName } from "../config";
import type { ServerDeps } from "../deps";
import { getDb, immediate } from "../db";
import { UnauthorizedError } from "../errors";
import { hashToken, looksLikeToken } from "./tokens";
import type { FundingSource } from "../models/access";

export const SESSION_COOKIE = "glossy_session";
export const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

// Browsers scope cookies to a host, not a port. Keep localhost workspaces on
// separate session names while production keeps the stable cookie contract.
export function getSessionCookieName(request?: Request, hostHeader?: string): string {
  if (process.env.NODE_ENV === "production") return SESSION_COOKIE;
  const host = hostHeader ?? request?.headers.get("host");
  const hostPort = host?.match(/(?:^|\]):(\d+)$/)?.[1] ?? host?.match(/:(\d+)$/)?.[1];
  const requestPort = request ? new URL(request.url).port : "";
  const port = hostPort || requestPort || process.env.PORT || "3000";
  return `${SESSION_COOKIE}_${port}`;
}

export interface Learner {
  id: string;
  displayName: string;
  quotaProfile: QuotaProfileName;
  fundingSource?: FundingSource;
}

// Resolves a raw session token to its learner, or null when the token is
// missing, malformed, unknown or expired, or the learner was deleted.
export function findLearnerBySessionToken(
  token: string | null | undefined,
  deps: ServerDeps = {},
): Learner | null {
  if (!looksLikeToken(token)) return null;
  const row = (deps.db ?? getDb())
    .prepare(
      `SELECT l.id, l.display_name, l.quota_profile, l.funding_source
       FROM sessions s JOIN learners l ON l.id = s.learner_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND l.deleted_at IS NULL`,
    )
    .get(hashToken(token), (deps.now ?? new Date()).toISOString());
  if (!row) return null;
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    quotaProfile: QuotaProfileNameSchema.parse(row.quota_profile),
    fundingSource: row.funding_source === "byok" ? "byok" : "hosted",
  };
}

// Pure variant of requireLearner for tests and non-request callers.
export function requireLearnerFromToken(
  token: string | null | undefined,
  deps: ServerDeps = {},
): Learner {
  const learner = findLearnerBySessionToken(token, deps);
  if (!learner) throw new UnauthorizedError();
  return learner;
}

// Extends only a live session. The write lock makes renewal safe alongside
// signout, invite redemption and another request using the same session.
export function renewSessionExpiry(
  token: string | null | undefined,
  deps: ServerDeps = {},
): Date | null {
  if (!looksLikeToken(token)) return null;
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const db = deps.db ?? getDb();
  const renewed = immediate((tx) => {
    const row = tx.prepare(
      `SELECT 1 FROM sessions s JOIN learners l ON l.id = s.learner_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND l.deleted_at IS NULL`,
    ).get(hashToken(token), nowIso);
    if (!row) return false;
    return tx.prepare(
      "UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at > ?",
    ).run(expiresAt.toISOString(), hashToken(token), nowIso).changes === 1;
  }, db);
  return renewed ? expiresAt : null;
}
