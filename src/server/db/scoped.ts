import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getDb } from "./connection";

// Tables whose rows belong to one learner. Every read goes through a
// LearnerScope so the learner filter cannot be forgotten.
export const LEARNER_OWNED_TABLES = [
  "check_runs",
  "detect_runs",
  "suggestions",
  "usage_reservations",
  "sessions",
  "expressions",
  "practice_tasks",
  "attempts",
  "evaluations",
  "evidence_events",
] as const;
export type LearnerOwnedTable = (typeof LEARNER_OWNED_TABLES)[number];

export type SqlParams = Record<string, SQLInputValue>;
export type Row = Record<string, unknown>;

export interface SelectOptions {
  // Extra condition, ANDed with the learner filter. Static SQL only: pass
  // values through `params`, never by string concatenation.
  where?: string;
  params?: SqlParams;
  // e.g. "created_at DESC, id".
  orderBy?: string;
  limit?: number;
}

export interface LearnerScope {
  readonly learnerId: string;
  select<T extends Row = Row>(table: LearnerOwnedTable, options?: SelectOptions): T[];
  selectOne<T extends Row = Row>(table: LearnerOwnedTable, options?: SelectOptions): T | undefined;
  count(table: LearnerOwnedTable, options?: Pick<SelectOptions, "where" | "params">): number;
}

const LEARNER_PARAM = "scope_learner_id";
const ORDER_BY = /^[a-z_]+( (ASC|DESC))?(, [a-z_]+( (ASC|DESC))?)*$/i;

export function learnerScope(learnerId: string, db: DatabaseSync = getDb()): LearnerScope {
  if (!learnerId) throw new TypeError("learnerScope requires a learner id");

  function where(options: SelectOptions | undefined): { clause: string; params: SqlParams } {
    const extra = options?.params ?? {};
    if (LEARNER_PARAM in extra) throw new TypeError(`Reserved parameter name: ${LEARNER_PARAM}`);
    // The caller's condition is parenthesised so an OR inside it cannot
    // widen the learner filter.
    const condition = options?.where ? ` AND (${options.where})` : "";
    return {
      clause: `learner_id = :${LEARNER_PARAM}${condition}`,
      params: { ...extra, [LEARNER_PARAM]: learnerId },
    };
  }

  function select<T extends Row = Row>(table: LearnerOwnedTable, options?: SelectOptions): T[] {
    assertTable(table);
    const { clause, params } = where(options);
    let sql = `SELECT * FROM ${table} WHERE ${clause}`;
    if (options?.orderBy) {
      if (!ORDER_BY.test(options.orderBy)) throw new TypeError("Invalid orderBy");
      sql += ` ORDER BY ${options.orderBy}`;
    }
    if (options?.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 0) {
        throw new TypeError("Invalid limit");
      }
      sql += ` LIMIT ${options.limit}`;
    }
    return db.prepare(sql).all(params).map((row) => ({ ...row }) as unknown as T);
  }

  function selectOne<T extends Row = Row>(
    table: LearnerOwnedTable,
    options?: SelectOptions,
  ): T | undefined {
    return select<T>(table, { ...options, limit: 1 })[0];
  }

  function count(table: LearnerOwnedTable, options?: Pick<SelectOptions, "where" | "params">) {
    assertTable(table);
    const { clause, params } = where(options);
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${clause}`).get(params);
    return Number(row?.n ?? 0);
  }

  return { learnerId, select, selectOne, count };
}

function assertTable(table: string): asserts table is LearnerOwnedTable {
  if (!(LEARNER_OWNED_TABLES as readonly string[]).includes(table)) {
    throw new TypeError(`Not a learner-owned table: ${table}`);
  }
}
