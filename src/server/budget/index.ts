// Pay-before-you-call budget accounting. Three limits apply to every cloud
// model call: a per-learner daily quota by kind, one daily spend ceiling for
// the whole instance, and one all-time (period) hosted spend ceiling with an
// owner funding expiry. A reservation is made before the call (reserve) and
// closed after it (settle, or markUnknown when the outcome is lost). Daily
// limits use the UTC day; the period total never resets and survives restarts
// because it is always recomputed from the ledger rows.
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
import { queueSpendAlertCheck } from "./alerts";

export const DEFAULT_PERIOD_BUDGET_MICROS = 25_000_000;
export const DEFAULT_OWNER_FUNDED_UNTIL = "2026-11-09T08:00:00Z";

export interface BudgetDeps extends ServerDeps {
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
  // Model role that fixed the cost bound (e.g. "proofread"). Defaults to kind.
  role?: string;
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
  // Model role for spend grouping. Defaults to kind.
  role?: string;
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
  const role = normalizeRole(input.role, input.kind);

  let alert: { db: DatabaseSync; spent: number; dailySpent: number } | null = null;

  const result = immediate((db) => {
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
    if (safeAdd(used, input.units) > limit) throw new QuotaExceededError(input.kind, used, limit);

    if (learner.funding_source !== "hosted" && learner.funding_source !== "byok") throw new AiDisabledError();
    const hosted = learner.funding_source === "hosted";
    if (!hosted) enforceVisitorRate(db, input.learnerId, now);

    // Owner funding expiry and all-time period cap apply to hosted only.
    // BYOK callers pay their own provider and bypass dollar ceilings.
    const periodCeiling = readPeriodCeiling(config);
    const untilMs = readFundedUntilMs(config);
    if (hosted && now.getTime() >= untilMs) throw new BudgetExhaustedError();

    const dailySpent = spentMicros(db, start, end);
    if (hosted && safeAdd(dailySpent, input.maxCostMicros) > config.dailyBudgetMicros) {
      throw new BudgetExhaustedError();
    }
    if (hosted) {
      const periodSpent = periodSpentMicros(db);
      if (safeAdd(periodSpent, input.maxCostMicros) > periodCeiling) {
        throw new BudgetExhaustedError();
      }
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
      role,
    };
    db.prepare(
      `INSERT INTO usage_reservations
         (id, learner_id, kind, request_id, units, max_cost_micros, status, created_at, funding_source, role)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
    ).run(reservation.id, reservation.learnerId, reservation.kind, reservation.requestId,
      reservation.units, reservation.maxCostMicros, reservation.createdAt,
      reservation.fundingSource, role);
    if (hosted) {
      // Recompute inside the same transaction so the alert sees the new total
      // without a second read after commit.
      alert = {
        db,
        spent: safeAdd(periodSpentMicros(db), 0),
        dailySpent: safeAdd(spentMicros(db, start, end), 0),
      };
    }
    return { ...reservation, replay: false };
  }, deps.db ?? getDb());

  // Network never happens inside the transaction: the claim and the POST run
  // later on the microtask queue, after commit.
  if (alert && !result.replay) {
    const { db: alertDb, spent, dailySpent } = alert;
    const cfg = config;
    const at = now;
    queueMicrotask(() => {
      try {
        queueSpendAlertCheck(alertDb, at, cfg, { periodSpent: spent, dailySpent });
      } catch {
        // Alerts never break reservations; webhook details stay out of errors.
      }
    });
  }
  return result;
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
// micro-dollars round up. Settling twice is a no-op: the first cost stands,
// so a later zero never erases a recorded positive charge. A reservation
// marked unknown can still be settled if the usage turns up later. A stored
// zero stays on the row for audit, but spend accounting treats zero (or
// missing) actuals as untrusted and keeps counting max cost (see spentMicros).
export function settle(
  reservationId: string,
  actualCostMicros: number,
  deps: BudgetDeps = {},
): Reservation {
  if (!Number.isFinite(actualCostMicros) || actualCostMicros < 0) {
    throw new RangeError("actualCostMicros must be a non-negative number");
  }
  const cost = Math.ceil(actualCostMicros);
  if (!Number.isSafeInteger(cost)) {
    throw new RangeError("actualCostMicros must settle to a safe integer");
  }
  const now = deps.now ?? new Date();

  return immediate((db) => {
    const row = findReservation(db, reservationId);
    if (row.status === "settled") return toReservation(row);
    // Caller estimates are not provider evidence. Only the mandatory transport
    // can persist a reported cost; without it a call keeps its full bound.
    const charged = Number(row.reported_cost_micros) > 0
      ? Number(row.reported_cost_micros)
      : cost === 0 ? 0 : Number(row.max_cost_micros);
    db.prepare(
      `UPDATE usage_reservations
       SET status = 'settled', actual_cost_micros = ?, settled_at = ? WHERE id = ?`,
    ).run(charged, now.toISOString(), reservationId);
    return toReservation(findReservation(db, reservationId));
  }, deps.db ?? getDb());
}

// Only the budget transport may call this after reading the provider response.
// The architecture check enforces that source boundary. A dispatch claim is
// required, and this write must commit before the response leaves the transport.
export function recordProviderReportedCost(
  reservationId: string,
  costMicros: number,
  deps: BudgetDeps = {},
): Reservation {
  assertInteger("reportedCostMicros", costMicros, 1);
  const db = deps.db ?? getDb();
  if (db.isTransaction) throw new Error("Provider cost requires a committed dispatch");
  const result = immediate((tx) => {
    const row = findReservation(tx, reservationId);
    if (!tx.prepare("SELECT 1 FROM budget_dispatches WHERE reservation_id = ?").get(reservationId)) {
      throw new Error("Provider cost requires a dispatch claim");
    }
    if (Number(row.reported_cost_micros) > 0) return toReservation(row);
    tx.prepare(`UPDATE usage_reservations SET reported_cost_micros = ?, actual_cost_micros = ?,
      status = 'settled', settled_at = ? WHERE id = ?`).run(
      costMicros, costMicros, (deps.now ?? new Date()).toISOString(), reservationId,
    );
    // An invoice outside the validated bound invalidates the price assumption.
    // Keep the real charge and stop further calls until the operator investigates.
    if (costMicros > Number(row.max_cost_micros)) setAiEnabled(false, { db: tx });
    return toReservation(findReservation(tx, reservationId));
  }, db);
  const config = deps.config ?? getConfig();
  if (config.spendAlertTelegram) queueMicrotask(() => {
    try {
      const now = deps.now ?? new Date();
      const status = getBudgetStatus({ db, now, config });
      queueSpendAlertCheck(db, now, config, { dailySpent: status.spentMicros, periodSpent: status.periodSpentMicros });
    } catch { /* Alerts cannot change a recorded charge. */ }
  });
  return result;
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
  // A settled zero counts as max: zero reports are untrusted.
  spentMicros: number;
  ceilingReached: boolean;
  // Kill switch on and the ceiling not reached: what /api/me reports.
  aiAvailable: boolean;
  // All-time hosted charged spend (never resets) and its ceiling.
  periodSpentMicros: number;
  periodCeilingMicros: number;
  // True when now is at or past ownerFundedUntil: hosted calls are refused.
  expired: boolean;
}

export function getBudgetStatus(deps: BudgetDeps = {}): BudgetStatus {
  const db = deps.db ?? getDb();
  const config = deps.config ?? getConfig();
  const now = deps.now ?? new Date();
  const { start, end } = utcDayBounds(now);
  const runtimeSwitchOn = readRuntimeSwitch(db);
  const switchOn = config.aiEnabled && runtimeSwitchOn;
  const spent = spentMicros(db, start, end);
  const periodSpent = periodSpentMicros(db);
  const periodCeiling = readPeriodCeiling(config);
  const expired = now.getTime() >= readFundedUntilMs(config);
  const ceilingReached = spent >= config.dailyBudgetMicros || periodSpent >= periodCeiling || expired;
  return {
    envSwitchOn: config.aiEnabled,
    runtimeSwitchOn,
    switchOn,
    ceilingMicros: config.dailyBudgetMicros,
    spentMicros: spent,
    ceilingReached,
    aiAvailable: switchOn && !ceilingReached,
    periodSpentMicros: periodSpent,
    periodCeilingMicros: periodCeiling,
    expired,
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
       WHERE learner_id = ? AND kind = ? AND created_at >= ? AND created_at < ?
         AND funding_source = (SELECT funding_source FROM learners WHERE id = ?)`,
    )
    .get(learnerId, kind, start, end, learnerId);
  return Number(row?.used ?? 0);
}

// Hosted spend charged today. One row's charge: `recordProviderReportedCost`
// writes the provider cost to both actual_cost_micros and
// reported_cost_micros; the second is the source of truth, so the first must
// not be added a second time. Only a provider report lowers a charge; an
// untrusted actual of 0 (or missing) and every open or unknown row count max.
const ROW_CHARGE = `CASE
  WHEN reported_cost_micros > 0 THEN reported_cost_micros
  WHEN status = 'settled' AND COALESCE(actual_cost_micros, 0) = max_cost_micros THEN max_cost_micros
  WHEN status = 'settled' AND COALESCE(actual_cost_micros, 0) > 0 THEN COALESCE(actual_cost_micros, 0)
  ELSE max_cost_micros END`;

function spentMicros(db: DatabaseSync, start: string, end: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(${ROW_CHARGE}), 0) AS spent
       FROM usage_reservations WHERE funding_source = 'hosted' AND created_at >= ? AND created_at < ?`,
    )
    .get(start, end);
  const spent = Number(row?.spent ?? 0);
  if (!Number.isSafeInteger(spent)) throw new RangeError("daily spend total is not a safe integer");
  return spent;
}

// All-time hosted charged spend. Intentionally unfiltered by date: prior rows
// always count, so the total survives restarts and UTC day rollovers.
function periodSpentMicros(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(${ROW_CHARGE}), 0) AS spent
       FROM usage_reservations WHERE funding_source = 'hosted'`,
    )
    .get();
  const spent = Number(row?.spent ?? 0);
  if (!Number.isSafeInteger(spent)) throw new RangeError("period spend total is not a safe integer");
  return spent;
}

function findReservation(db: DatabaseSync, id: string): Record<string, SQLOutputValue> {
  const row = db.prepare("SELECT * FROM usage_reservations WHERE id = ?").get(id);
  if (!row) throw new Error(`Unknown reservation ${id}`);
  return row;
}

function toReservation(row: Record<string, SQLOutputValue>): Reservation {
  const kind = row.kind as QuotaKind;
  return {
    id: String(row.id),
    learnerId: String(row.learner_id),
    fundingSource: row.funding_source === "byok" ? "byok" : "hosted",
    kind,
    requestId: String(row.request_id),
    units: Number(row.units),
    maxCostMicros: Number(row.max_cost_micros),
    actualCostMicros: row.actual_cost_micros === null ? null : Number(row.actual_cost_micros),
    status: row.status as ReservationStatus,
    createdAt: String(row.created_at),
    settledAt: row.settled_at === null ? null : String(row.settled_at),
    role: String(row.role),
  };
}

function normalizeRole(role: string | undefined, kind: QuotaKind): string {
  const trimmed = (role ?? kind).trim();
  const value = trimmed.length > 0 ? trimmed : kind;
  if (value.length > 64) throw new RangeError("role must be at most 64 characters");
  return value;
}

export function readPeriodCeiling(config: AppConfig): number {
  const raw = config.periodBudgetMicros;
  if (raw === undefined) return DEFAULT_PERIOD_BUDGET_MICROS;
  if (!Number.isSafeInteger(raw) || (raw as number) < 0) {
    throw new RangeError("periodBudgetMicros must be a safe integer >= 0");
  }
  return raw as number;
}

export function readFundedUntilMs(config: AppConfig): number {
  const raw = config.ownerFundedUntil;
  const text = raw ?? DEFAULT_OWNER_FUNDED_UNTIL;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new RangeError("ownerFundedUntil must be a valid ISO date string");
  return ms;
}

export function readSpendAlertTelegram(config: AppConfig): { botToken: string; chatId: string } | undefined {
  const target = config.spendAlertTelegram;
  if (!target) return undefined;
  const botToken = target.botToken?.trim();
  const chatId = target.chatId?.trim();
  if (!botToken || !chatId) return undefined;
  return { botToken, chatId };
}

function safeAdd(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new RangeError("budget arithmetic needs safe integers");
  }
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new RangeError("budget sum exceeds safe integers");
  return sum;
}

function assertInteger(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}`);
  }
}
