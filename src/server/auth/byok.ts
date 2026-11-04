import type { ServerDeps } from "../deps";
import { getDb, immediate } from "../db";
import { newId } from "../ids";
import type { Redemption } from "./invites";
import { QuotaProfileNameSchema } from "../config";
import { SESSION_TTL_MS, type Learner } from "./sessions";
import { generateToken, hashToken, looksLikeToken } from "./tokens";

// The provider key is deliberately absent from this function and its storage.
export function createByokSession(deps: ServerDeps = {}): Redemption {
  const now = deps.now ?? new Date();
  return immediate(db => {
    const learner = { id: newId(), displayName: "Your workspace", quotaProfile: "pilot" as const,
      fundingSource: "byok" as const };
    db.prepare(
      `INSERT INTO learners (id, display_name, quota_profile, funding_source, created_at)
       VALUES (?, ?, 'pilot', 'byok', ?)`,
    ).run(learner.id, learner.displayName, now.toISOString());
    const sessionToken = generateToken();
    const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    db.prepare(
      "INSERT INTO sessions (token_hash, learner_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ).run(hashToken(sessionToken), learner.id, now.toISOString(), sessionExpiresAt.toISOString());
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
    return { learner, sessionToken, sessionExpiresAt };
  }, deps.db ?? getDb());
}

export interface ByokUpgrade {
  learner: Learner;
  sessionExpiresAt: Date;
}

// An explicit visitor key can move any live hosted learner to BYOK without
// changing the learner id or their saved work. Historical reservations keep
// the funding source recorded when they were created.
export function switchSessionToByok(
  token: string | null | undefined,
  deps: ServerDeps = {},
): ByokUpgrade | null {
  if (!looksLikeToken(token)) return null;
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const db = deps.db ?? getDb();

  return immediate((tx) => {
    const row = tx.prepare(
      `SELECT l.id, l.display_name, l.quota_profile, l.funding_source
       FROM sessions s JOIN learners l ON l.id = s.learner_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND l.deleted_at IS NULL`,
    ).get(hashToken(token), nowIso);
    if (!row) return null;

    const currentProfile = QuotaProfileNameSchema.parse(row.quota_profile);
    const nextProfile = currentProfile === "guest" ? "pilot" : currentProfile;
    if (row.funding_source !== "byok") {
      tx.prepare(
        `UPDATE learners SET funding_source = 'byok', quota_profile = ?
         WHERE id = ? AND funding_source = 'hosted'`,
      ).run(nextProfile, String(row.id));
    }
    tx.prepare(
      "UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at > ?",
    ).run(sessionExpiresAt.toISOString(), hashToken(token), nowIso);

    return {
      learner: {
        id: String(row.id),
        displayName: String(row.display_name),
        quotaProfile: nextProfile,
        fundingSource: "byok",
      },
      sessionExpiresAt,
    };
  }, db);
}

export function endSession(token: string | null | undefined, deps: ServerDeps = {}): void {
  if (looksLikeToken(token)) {
    (deps.db ?? getDb()).prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }
}
