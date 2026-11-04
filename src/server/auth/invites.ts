import { QuotaProfileNameSchema, type QuotaProfileName } from "../config";
import type { ServerDeps } from "../deps";
import { getDb, immediate } from "../db";
import { InvalidInviteError } from "../errors";
import { newId } from "../ids";
import { generateToken, hashToken, looksLikeToken } from "./tokens";
import { SESSION_TTL_MS, type Learner } from "./sessions";

export type InviteQuotaProfileName = Exclude<QuotaProfileName, "guest">;

export interface CreateInviteInput {
  label: string;
  maxUses: number;
  quotaProfile: InviteQuotaProfileName;
  expiresAt?: Date | null;
}

export interface CreatedInvite {
  // The raw token. It is returned once and cannot be recovered later.
  token: string;
  label: string;
  maxUses: number;
  quotaProfile: InviteQuotaProfileName;
  expiresAt: string | null;
}

export function createInvite(
  input: CreateInviteInput,
  deps: ServerDeps = {},
): CreatedInvite {
  const label = input.label.trim();
  if (label.length < 1 || label.length > 60) {
    throw new RangeError("Invite label must be 1-60 characters");
  }
  if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > 10_000) {
    throw new RangeError("maxUses must be an integer between 1 and 10000");
  }
  const quotaProfile = QuotaProfileNameSchema.parse(input.quotaProfile);
  if (quotaProfile === "guest") {
    throw new RangeError("Invite profile must be pilot, judge, or owner");
  }
  if (input.expiresAt && Number.isNaN(input.expiresAt.getTime())) {
    throw new RangeError("expiresAt is not a valid date");
  }
  const now = deps.now ?? new Date();
  const expiresAt = input.expiresAt ? input.expiresAt.toISOString() : null;

  const token = generateToken();
  (deps.db ?? getDb())
    .prepare(
      `INSERT INTO invites (token_hash, label, quota_profile, max_uses, uses, expires_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(hashToken(token), label, quotaProfile, input.maxUses, expiresAt, now.toISOString());

  return { token, label, maxUses: input.maxUses, quotaProfile, expiresAt };
}

export interface Redemption {
  learner: Learner;
  // The raw session token to put in the cookie.
  sessionToken: string;
  sessionExpiresAt: Date;
}

// Spends one use of the invite and creates a learner plus a session, all in
// one transaction. Unknown, expired and used-up invites throw
// InvalidInviteError; the caller must not tell them apart to the visitor.
export function redeemInvite(token: unknown, deps: ServerDeps = {}): Redemption {
  if (!looksLikeToken(token)) throw new InvalidInviteError("unknown");

  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const tokenHash = hashToken(token);

  return immediate((db) => {
    // The guarded UPDATE is the atomic gate: it either claims a use or matches nothing.
    const claimed = db
      .prepare(
        `UPDATE invites SET uses = uses + 1
         WHERE token_hash = ? AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(tokenHash, nowIso);

    const invite = db
      .prepare(
        "SELECT label, quota_profile, uses, expires_at FROM invites WHERE token_hash = ?",
      )
      .get(tokenHash);

    if (claimed.changes === 0) {
      if (!invite) throw new InvalidInviteError("unknown");
      if (invite.expires_at !== null && String(invite.expires_at) <= nowIso) {
        throw new InvalidInviteError("expired");
      }
      throw new InvalidInviteError("used_up");
    }
    if (!invite) throw new InvalidInviteError("unknown");

    const quotaProfile = QuotaProfileNameSchema.parse(invite.quota_profile);
    const learner: Learner = {
      id: newId(),
      // "<label> <n>": n is the redemption number of this invite.
      displayName: `${String(invite.label)} ${Number(invite.uses)}`,
      quotaProfile,
      fundingSource: "hosted",
    };
    db.prepare(
      "INSERT INTO learners (id, display_name, quota_profile, created_at) VALUES (?, ?, ?, ?)",
    ).run(learner.id, learner.displayName, learner.quotaProfile, nowIso);

    const sessionToken = generateToken();
    const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    db.prepare(
      "INSERT INTO sessions (token_hash, learner_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ).run(hashToken(sessionToken), learner.id, nowIso, sessionExpiresAt.toISOString());
    db.prepare(
      "INSERT INTO invite_redemptions (token_hash, learner_id, redeemed_at) VALUES (?, ?, ?)",
    ).run(tokenHash, learner.id, nowIso);

    // Housekeeping: expired sessions are useless, so keep the table small.
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso);

    return { learner, sessionToken, sessionExpiresAt };
  }, deps.db ?? getDb());
}

const PROFILE_RANK: Record<QuotaProfileName, number> = {
  guest: 0,
  pilot: 1,
  judge: 2,
  owner: 3,
};

// An invite upgrades the current learner in place when it offers a higher
// profile. Existing work and BYOK funding stay attached to that learner.
export function redeemInviteForSession(
  token: unknown,
  sessionToken: string | null | undefined,
  deps: ServerDeps = {},
): { learner: Learner; sessionExpiresAt: Date } | null {
  if (!looksLikeToken(sessionToken)) return null;
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const db = deps.db ?? getDb();

  return immediate((tx) => {
    const current = tx.prepare(
      `SELECT l.id, l.display_name, l.quota_profile, l.funding_source
       FROM sessions s JOIN learners l ON l.id = s.learner_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND l.deleted_at IS NULL`,
    ).get(hashToken(sessionToken), nowIso);
    if (!current) return null;
    if (!looksLikeToken(token)) throw new InvalidInviteError("unknown");
    const tokenHash = hashToken(token);
    const invite = tx.prepare(
      "SELECT quota_profile, uses, max_uses, expires_at FROM invites WHERE token_hash = ?",
    ).get(tokenHash);
    if (!invite) throw new InvalidInviteError("unknown");
    const learnerId = String(current.id);
    const priorRedemption = tx.prepare(
      "SELECT 1 FROM invite_redemptions WHERE token_hash = ? AND learner_id = ?",
    ).get(tokenHash, learnerId);
    if (priorRedemption) {
      tx.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at > ?")
        .run(sessionExpiresAt.toISOString(), hashToken(sessionToken), nowIso);
      return {
        learner: {
          id: learnerId,
          displayName: String(current.display_name),
          quotaProfile: QuotaProfileNameSchema.parse(current.quota_profile),
          fundingSource: current.funding_source === "byok" ? "byok" : "hosted",
        },
        sessionExpiresAt,
      };
    }
    if (invite.expires_at !== null && String(invite.expires_at) <= nowIso) {
      throw new InvalidInviteError("expired");
    }
    if (Number(invite.uses) >= Number(invite.max_uses)) throw new InvalidInviteError("used_up");

    const currentProfile = QuotaProfileNameSchema.parse(current.quota_profile);
    const offeredProfile = QuotaProfileNameSchema.parse(invite.quota_profile);
    const quotaProfile = PROFILE_RANK[offeredProfile] > PROFILE_RANK[currentProfile]
      ? offeredProfile
      : currentProfile;
    if (quotaProfile !== currentProfile) {
      const claimed = tx.prepare(
        `UPDATE invites SET uses = uses + 1
         WHERE token_hash = ? AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)`,
      ).run(tokenHash, nowIso);
      if (claimed.changes !== 1) throw new InvalidInviteError("used_up");
      tx.prepare("UPDATE learners SET quota_profile = ? WHERE id = ?").run(quotaProfile, learnerId);
      tx.prepare(
        "INSERT INTO invite_redemptions (token_hash, learner_id, redeemed_at) VALUES (?, ?, ?)",
      ).run(tokenHash, learnerId, nowIso);
    }
    tx.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at > ?")
      .run(sessionExpiresAt.toISOString(), hashToken(sessionToken), nowIso);
    return {
      learner: {
        id: learnerId,
        displayName: String(current.display_name),
        quotaProfile,
        fundingSource: current.funding_source === "byok" ? "byok" : "hosted",
      },
      sessionExpiresAt,
    };
  }, db);
}
