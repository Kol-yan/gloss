import { QuotaProfileNameSchema, type QuotaProfileName } from "../config";
import type { ServerDeps } from "../deps";
import { getDb, immediate } from "../db";
import { InvalidInviteError } from "../errors";
import { newId } from "../ids";
import { generateToken, hashToken, looksLikeToken } from "./tokens";
import { SESSION_TTL_MS, type Learner } from "./sessions";

export interface CreateInviteInput {
  label: string;
  maxUses: number;
  quotaProfile: QuotaProfileName;
  expiresAt?: Date | null;
}

export interface CreatedInvite {
  // The raw token. It is returned once and cannot be recovered later.
  token: string;
  label: string;
  maxUses: number;
  quotaProfile: QuotaProfileName;
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

    // Housekeeping: expired sessions are useless, so keep the table small.
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso);

    return { learner, sessionToken, sessionExpiresAt };
  }, deps.db ?? getDb());
}
