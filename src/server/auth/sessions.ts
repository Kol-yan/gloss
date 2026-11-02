import { QuotaProfileNameSchema, type QuotaProfileName } from "../config";
import type { ServerDeps } from "../deps";
import { getDb } from "../db";
import { UnauthorizedError } from "../errors";
import { hashToken, looksLikeToken } from "./tokens";

export const SESSION_COOKIE = "glossy_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

export interface Learner {
  id: string;
  displayName: string;
  quotaProfile: QuotaProfileName;
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
      `SELECT l.id, l.display_name, l.quota_profile
       FROM sessions s JOIN learners l ON l.id = s.learner_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND l.deleted_at IS NULL`,
    )
    .get(hashToken(token), (deps.now ?? new Date()).toISOString());
  if (!row) return null;
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    quotaProfile: QuotaProfileNameSchema.parse(row.quota_profile),
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
