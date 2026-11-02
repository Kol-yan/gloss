import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvite, redeemInvite } from "@/server/auth/invites";
import {
  findLearnerBySessionToken,
  requireLearnerFromToken,
  SESSION_TTL_MS,
} from "@/server/auth/sessions";
import { hashToken } from "@/server/auth/tokens";
import { learnerScope, openDatabase } from "@/server/db";
import { InvalidInviteError, UnauthorizedError } from "@/server/errors";
import { createTempDb, insertLearner, type TempDb } from "./helpers/db";

let temp: TempDb;
beforeAll(() => {
  temp = createTempDb();
});
afterAll(() => temp.cleanup());

const T0 = new Date("2026-11-02T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function invite(overrides: Partial<Parameters<typeof createInvite>[0]> = {}) {
  return createInvite(
    { label: "Judges", maxUses: 2, quotaProfile: "judge", ...overrides },
    { db: temp.db, now: T0 },
  );
}

describe("invites", () => {
  it("stores only hashes of invite and session tokens", () => {
    const created = invite();
    const { sessionToken } = redeemInvite(created.token, { db: temp.db, now: T0 });
    const dump = JSON.stringify([
      temp.db.prepare("SELECT * FROM invites").all(),
      temp.db.prepare("SELECT * FROM sessions").all(),
    ]);
    expect(dump).not.toContain(created.token);
    expect(dump).not.toContain(sessionToken);
    expect(dump).toContain(hashToken(created.token));
    expect(dump).toContain(hashToken(sessionToken));
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("redeems up to max uses, numbering learners, then rejects", () => {
    const created = invite({ label: "Panel", maxUses: 2 });
    const first = redeemInvite(created.token, { db: temp.db, now: T0 });
    const second = redeemInvite(created.token, { db: temp.db, now: T0 });
    expect(first.learner.displayName).toBe("Panel 1");
    expect(second.learner.displayName).toBe("Panel 2");
    expect(first.learner.quotaProfile).toBe("judge");
    expect(first.learner.id).not.toBe(second.learner.id);
    expect(() => redeemInvite(created.token, { db: temp.db, now: T0 })).toThrowError(
      expect.objectContaining({ name: "InvalidInviteError", reason: "used_up" }),
    );
    expect(
      temp.db.prepare("SELECT uses FROM invites WHERE token_hash = ?").get(hashToken(created.token)),
    ).toEqual({ uses: 2 });
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM learners WHERE display_name LIKE 'Panel %'").get())
      .toEqual({ n: 2 });
  });

  it("is atomic across two connections to the same file", () => {
    const created = invite({ label: "Race", maxUses: 1 });
    const second = openDatabase(temp.path);
    try {
      redeemInvite(created.token, { db: temp.db, now: T0 });
      expect(() => redeemInvite(created.token, { db: second, now: T0 })).toThrow(InvalidInviteError);
    } finally {
      second.close();
    }
  });

  it("rejects an expired invite without spending a use", () => {
    const created = invite({ label: "Old", expiresAt: at(60_000) });
    expect(() => redeemInvite(created.token, { db: temp.db, now: at(60_000) })).toThrowError(
      expect.objectContaining({ reason: "expired" }),
    );
    expect(redeemInvite(created.token, { db: temp.db, now: at(59_999) }).learner.displayName).toBe(
      "Old 1",
    );
    expect(
      temp.db.prepare("SELECT uses FROM invites WHERE token_hash = ?").get(hashToken(created.token)),
    ).toEqual({ uses: 1 });
  });

  it("rejects unknown and malformed tokens", () => {
    for (const token of ["", "nope", "x".repeat(43), undefined, null, 42]) {
      expect(() => redeemInvite(token, { db: temp.db, now: T0 })).toThrowError(
        expect.objectContaining({ reason: "unknown" }),
      );
    }
  });

  it("validates createInvite input", () => {
    expect(() => invite({ label: "  " })).toThrow(RangeError);
    expect(() => invite({ maxUses: 0 })).toThrow(RangeError);
    expect(() => invite({ quotaProfile: "admin" as "pilot" })).toThrow();
  });
});

describe("sessions", () => {
  it("lasts 30 days and then stops resolving", () => {
    const { sessionToken, sessionExpiresAt } = redeemInvite(invite({ maxUses: 1 }).token, {
      db: temp.db,
      now: T0,
    });
    expect(sessionExpiresAt.getTime() - T0.getTime()).toBe(SESSION_TTL_MS);
    expect(findLearnerBySessionToken(sessionToken, { db: temp.db, now: at(SESSION_TTL_MS - 1) }))
      .not.toBeNull();
    expect(findLearnerBySessionToken(sessionToken, { db: temp.db, now: at(SESSION_TTL_MS) }))
      .toBeNull();
    expect(() =>
      requireLearnerFromToken(sessionToken, { db: temp.db, now: at(SESSION_TTL_MS + 1) }),
    ).toThrow(UnauthorizedError);
  });

  it("rejects missing, malformed and unknown tokens", () => {
    for (const token of [undefined, null, "", "short", "y".repeat(43)]) {
      expect(() => requireLearnerFromToken(token, { db: temp.db, now: T0 })).toThrow(
        UnauthorizedError,
      );
    }
  });

  it("does not resolve a deleted learner", () => {
    const { sessionToken, learner } = redeemInvite(invite({ maxUses: 1 }).token, {
      db: temp.db,
      now: T0,
    });
    temp.db.prepare("UPDATE learners SET deleted_at = ? WHERE id = ?").run(T0.toISOString(), learner.id);
    expect(findLearnerBySessionToken(sessionToken, { db: temp.db, now: T0 })).toBeNull();
  });

  it("removes expired sessions when a new invite is redeemed", () => {
    const old = redeemInvite(invite({ maxUses: 1 }).token, { db: temp.db, now: T0 });
    redeemInvite(invite({ maxUses: 1 }).token, { db: temp.db, now: at(SESSION_TTL_MS + 1) });
    expect(
      temp.db.prepare("SELECT 1 FROM sessions WHERE token_hash = ?").get(hashToken(old.sessionToken)),
    ).toBeUndefined();
  });
});

describe("learner isolation", () => {
  it("resolves each session to its own learner only", () => {
    const created = invite({ label: "Pair", maxUses: 2 });
    const a = redeemInvite(created.token, { db: temp.db, now: T0 });
    const b = redeemInvite(created.token, { db: temp.db, now: T0 });
    expect(requireLearnerFromToken(a.sessionToken, { db: temp.db, now: T0 }).id).toBe(a.learner.id);
    expect(requireLearnerFromToken(b.sessionToken, { db: temp.db, now: T0 }).id).toBe(b.learner.id);
    expect(a.learner.id).not.toBe(b.learner.id);
  });

  it("learnerScope never returns another learner's rows", () => {
    const a = insertLearner(temp.db, "pilot", "A");
    const b = insertLearner(temp.db, "pilot", "B");
    const now = T0.toISOString();
    const addRun = (learner: string, request: string) =>
      temp.db
        .prepare(
          `INSERT INTO check_runs (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
           VALUES (?, ?, ?, 'h', 1, 'p', 'm', 'ok', ?)`,
        )
        .run(`${learner}-${request}`, learner, request, now);
    addRun(a, "1");
    addRun(a, "2");
    addRun(b, "1");

    const scopeA = learnerScope(a, temp.db);
    const scopeB = learnerScope(b, temp.db);
    expect(scopeA.select("check_runs").map((r) => r.id).sort()).toEqual([`${a}-1`, `${a}-2`]);
    expect(scopeB.select("check_runs").map((r) => r.id)).toEqual([`${b}-1`]);
    expect(scopeA.count("check_runs")).toBe(2);

    // B's row is invisible to A even when asked for by id.
    expect(scopeA.selectOne("check_runs", { where: "id = :id", params: { id: `${b}-1` } }))
      .toBeUndefined();
    // A caller condition cannot widen the learner filter.
    expect(
      scopeA.select("check_runs", { where: "status = 'nope' OR 1 = 1" }).every((r) => r.learner_id === a),
    ).toBe(true);
    expect(scopeA.count("check_runs", { where: "1 = 1 OR 1 = 1" })).toBe(2);
  });

  it("learnerScope rejects unsafe input", () => {
    const scope = learnerScope("someone", temp.db);
    expect(() => scope.select("learners" as "check_runs")).toThrow(TypeError);
    expect(() => scope.select("check_runs", { orderBy: "id; DROP TABLE learners" })).toThrow(TypeError);
    expect(() => scope.select("check_runs", { params: { scope_learner_id: "other" } })).toThrow(TypeError);
    expect(() => learnerScope("", temp.db)).toThrow(TypeError);
  });
});
