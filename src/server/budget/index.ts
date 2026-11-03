// Pay-before-you-call budget accounting. Two independent limits apply to
// every cloud model call: a per-learner daily quota by kind, and one daily
// spend ceiling for the whole instance. A reservation is made before the call
// (reserve) and closed after it (settle, or markUnknown when the outcome is
// lost). All limits use the UTC day.
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { QuotaKind } from "@/shared/contracts";
import {
  getConfig,
  quotaLimits,
  QuotaProfileNameSchema,
  type AppConfig,
  type QuotaProfileName,
} from "../config";
import { getDb, immediate } from "../db";
import type { ServerDeps } from "../deps";
import {
  AiDisabledError,
  BudgetExhaustedError,
  QuotaExceededError,
  RateLimitedError,
  UnauthorizedError,
} from "../errors";
import { newId } from "../ids";
import { staleBefore } from "../stale";
import type { FundingSource } from "../models/access";

export interface BudgetDeps extends ServerDeps {
  // Overrides the environment configuration (tests).
  config?: AppConfig;
}

export type ReservationStatus = "reserved" | "settled" | "unknown";

export interface Reservation {
  id: string;
  learnerId: string;
  fundingSource: FundingSource;
  kind: QuotaKind;
  requestId: string;
  units: number;
  maxCostMicros: number;
  actualCostMicros: number | null;
  status: ReservationStatus;
  createdAt: string;
  settledAt: string | null;
}

export type ReserveResult = Reservation & {
  // True when this (learner, kind, requestId) was already reserved: nothing
  // was counted again and the earlier reservation is returned.
  replay: boolean;
};

export interface ReserveInput {
  learnerId: string;
  kind: QuotaKind;
  requestId: string;
  // Operations for proofread/detect/evaluate, whole seconds for asrSeconds.
  units: number;
  // Upper bound on the call's cost in micro-dollars.
  maxCostMicros: number;
}

const AI_ENABLED_KEY = "ai_enabled";

// [start, end) of the UTC day containing `now`, as ISO strings.
export function utcDayBounds(now: Date): { start: string; end: string } {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { start: new Date(start).toISOString(), end: new Date(start + 86_400_000).toISOString() };
}

export function reserve(input: ReserveInput, deps: BudgetDeps = {}): ReserveResult {
  assertInteger("units", input.units, 1);
  assertInteger("maxCostMicros", input.maxCostMicros, 0);
  if (!input.requestId) throw new TypeError("requestId is required");

  const config = deps.config ?? getConfig();
  const now = deps.now ?? new Date();

  return immediate((db) => {
    sweepStaleReservations(db, now);

    const existing = db
      .prepare(
        "SELECT * FROM usage_reservations WHERE learner_id = ? AND kind = ? AND request_id = ?",
      )
      .get(input.learnerId, input.kind, input.requestId);
    if (existing) return { ...toReservation(existing), replay: true };

    if (!aiSwitchOn(db, config)) throw new AiDisabledError();

    const learner = db
      .prepare("SELECT quota_profile, funding_source FROM learners WHERE id = ? AND deleted_at IS NULL")
      .get(input.learnerId);
    if (!learner) throw new UnauthorizedError();

    const { start, end } = utcDayBounds(now);
    const limit = quotaLimits(QuotaProfileNameSchema.parse(learner.quota_profile))[input.kind];
    const used = unitsUsed(db, input.learnerId, input.kind, start, end);
    if (used + input.units > limit) throw new QuotaExceededError(input.kind, used, limit);

    if (learner.funding_source !== "hosted" && learner.funding_source !== "byok") throw new AiDisabledError();
    if (learner.funding_source === "byok") enforceVisitorRate(db, input.learnerId, now);
    if (learner.funding_source === "hosted" && spentMicros(db, start, end) + input.maxCostMicros > config.dailyBudgetMicros) {
      throw new BudgetExhaustedError();
    }

    const reservation: Reservation = {
      id: newId(),
      learnerId: input.learnerId,
      fundingSource: learner.funding_source,
      kind: input.kind,
      requestId: input.requestId,
      units: input.units,
      maxCostMicros: input.maxCostMicros,
      actualCostMicros: null,
      status: "reserved",
      createdAt: now.toISOString(),
      settledAt: null,
    };
    db.prepare(
      `INSERT INTO usage_reservations
         (id, learner_id, kind, request_id, units, max_cost_micros, status, created_at, funding_source)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
    ).run(
      reservation.id,
      reservation.learnerId,
      reservation.kind,
      reservation.requestId,
      reservation.units,
      reservation.maxCostMicros,
      reservation.createdAt,
      reservation.fundingSource,
    );
    return { ...reservation, replay: false };
  }, deps.db ?? getDb());
}

// Visitors pay their own provider, but still share this server's capacity.
function enforceVisitorRate(db: DatabaseSync, learnerId: string, now: Date): void {
  const minute = new Date(now.getTime() - 60_000).toISOString();
  const counts = db.prepare(
    `SELECT SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS recent,
            SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) AS active
     FROM usage_reservations WHERE learner_id = ?`,
  ).get(minute, learnerId);
  if (Number(counts?.recent ?? 0) >= 6 || Number(counts?.active ?? 0) >= 2) throw new RateLimitedError();
}

// A reservation still 'reserved' after two minutes belongs to a call whose
// process died: nobody knows what the provider did, so it becomes 'unknown'.
// Its max cost keeps counting either way; only the label changes. A call that
// is somehow still running can still settle it.
function sweepStaleReservations(db: DatabaseSync, now: Date): void {
  db.prepare(
    "UPDATE usage_reservations SET status = 'unknown' WHERE status = 'reserved' AND created_at < ?",
  ).run(staleBefore(now));
}

// Records the real cost from the provider's reported usage. Fractional
// micro-dollars round up. Settling twice is a no-op: the first cost stands.
// A reservation marked unknown can still be settled if the usage turns up later.
export function settle(
  reservationId: string,
  actualCostMicros: number,
  deps: BudgetDeps = {},
): Reservation {
  if (!Number.isFinite(actualCostMicros) || actualCostMicros < 0) {
    throw new RangeError("actualCostMicros must be a non-negative number");
  }
  const cost = Math.ceil(actualCostMicros);
  const now = deps.now ?? new Date();

  return immediate((db) => {
    const row = findReservation(db, reservationId);
    if (row.status === "settled") return toReservation(row);
    db.prepare(
      `UPDATE usage_reservations
       SET status = 'settled', actual_cost_micros = ?, settled_at = ? WHERE id = ?`,
    ).run(cost, now.toISOString(), reservationId);
    return toReservation(findReservation(db, reservationId));
  }, deps.db ?? getDb());
}

// The call's outcome is unknown (timeout, dropped connection): the provider
// may have done the work, so the reservation keeps counting at max_cost.
export function markUnknown(reservationId: string, deps: BudgetDeps = {}): Reservation {
  return immediate((db) => {
    const row = findReservation(db, reservationId);
    if (row.status === "reserved") {
      db.prepare("UPDATE usage_reservations SET status = 'unknown' WHERE id = ?").run(
        reservationId,
      );
      return toReservation(findReservation(db, reservationId));
    }
    return toReservation(row);
  }, deps.db ?? getDb());
}

// Kill switch: the AI_ENABLED env var AND the runtime `ai_enabled` setting
// must both allow calls. A missing setting means enabled.
export function isAiEnabled(deps: BudgetDeps = {}): boolean {
  return aiSwitchOn(deps.db ?? getDb(), deps.config ?? getConfig());
}

export function setAiEnabled(enabled: boolean, deps: BudgetDeps = {}): void {
  (deps.db ?? getDb())
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .run(AI_ENABLED_KEY, enabled ? "true" : "false");
}

export interface BudgetStatus {
  // Both halves of the kill switch, and their combination.
  envSwitchOn: boolean;
  runtimeSwitchOn: boolean;
  switchOn: boolean;
  ceilingMicros: number;
  // Settled actual cost plus the max cost of open and unknown reservations.
  spentMicros: number;
  ceilingReached: boolean;
  // Kill switch on and the ceiling not reached: what /api/me reports.
  aiAvailable: boolean;
}

export function getBudgetStatus(deps: BudgetDeps = {}): BudgetStatus {
  const db = deps.db ?? getDb();
  const config = deps.config ?? getConfig();
  const { start, end } = utcDayBounds(deps.now ?? new Date());
  const runtimeSwitchOn = readRuntimeSwitch(db);
  const switchOn = config.aiEnabled && runtimeSwitchOn;
  const spent = spentMicros(db, start, end);
  const ceilingReached = spent >= config.dailyBudgetMicros;
  return {
    envSwitchOn: config.aiEnabled,
    runtimeSwitchOn,
    switchOn,
    ceilingMicros: config.dailyBudgetMicros,
    spentMicros: spent,
    ceilingReached,
    aiAvailable: switchOn && !ceilingReached,
  };
}

export function getQuotaUsage(
  learner: { id: string; quotaProfile: QuotaProfileName },
  deps: BudgetDeps = {},
): Record<QuotaKind, { used: number; limit: number }> {
  const db = deps.db ?? getDb();
  const { start, end } = utcDayBounds(deps.now ?? new Date());
  const limits = quotaLimits(learner.quotaProfile);
  return {
    proofread: {
      used: unitsUsed(db, learner.id, "proofread", start, end),
      limit: limits.proofread,
    },
    detect: {
      used: unitsUsed(db, learner.id, "detect", start, end),
      limit: limits.detect,
    },
    evaluate: {
      used: unitsUsed(db, learner.id, "evaluate", start, end),
      limit: limits.evaluate,
    },
    asrSeconds: {
      used: unitsUsed(db, learner.id, "asrSeconds", start, end),
      limit: limits.asrSeconds,
    },
  };
}

function aiSwitchOn(db: DatabaseSync, config: AppConfig): boolean {
  return config.aiEnabled && readRuntimeSwitch(db);
}

function readRuntimeSwitch(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(AI_ENABLED_KEY);
  // Fail closed on an unreadable value; a missing row means the default (on).
  return row ? row.value === "true" : true;
}

function unitsUsed(
  db: DatabaseSync,
  learnerId: string,
  kind: QuotaKind,
  start: string,
  end: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(units), 0) AS used FROM usage_reservations
       WHERE learner_id = ? AND kind = ? AND created_at >= ? AND created_at < ?`,
    )
    .get(learnerId, kind, start, end);
  return Number(row?.used ?? 0);
}

function spentMicros(db: DatabaseSync, start: string, end: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN status = 'settled'
                                THEN COALESCE(actual_cost_micros, max_cost_micros)
                                ELSE max_cost_micros END), 0) AS spent
       FROM usage_reservations WHERE funding_source = 'hosted' AND created_at >= ? AND created_at < ?`,
    )
    .get(start, end);
  return Number(row?.spent ?? 0);
}

function findReservation(db: DatabaseSync, id: string): Record<string, SQLOutputValue> {
  const row = db.prepare("SELECT * FROM usage_reservations WHERE id = ?").get(id);
  if (!row) throw new Error(`Unknown reservation ${id}`);
  return row;
}

function toReservation(row: Record<string, SQLOutputValue>): Reservation {
  return {
    id: String(row.id),
    learnerId: String(row.learner_id),
    fundingSource: row.funding_source === "byok" ? "byok" : "hosted",
    kind: row.kind as QuotaKind,
    requestId: String(row.request_id),
    units: Number(row.units),
    maxCostMicros: Number(row.max_cost_micros),
    actualCostMicros: row.actual_cost_micros === null ? null : Number(row.actual_cost_micros),
    status: row.status as ReservationStatus,
    createdAt: String(row.created_at),
    settledAt: row.settled_at === null ? null : String(row.settled_at),
  };
}

function assertInteger(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}`);
  }
}
