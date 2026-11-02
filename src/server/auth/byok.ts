import type { ServerDeps } from "../deps";
import { getDb, immediate } from "../db";
import { newId } from "../ids";
import type { Redemption } from "./invites";
import { SESSION_TTL_MS } from "./sessions";
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

export function endSession(token: string | null | undefined, deps: ServerDeps = {}): void {
  if (looksLikeToken(token)) {
    (deps.db ?? getDb()).prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }
}
