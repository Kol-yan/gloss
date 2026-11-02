import type { DatabaseSync } from "node:sqlite";

// Runs `fn` inside BEGIN IMMEDIATE ... COMMIT, rolling back if it throws.
// IMMEDIATE takes the write lock up front, so a read-check-write sequence
// (such as a budget reservation) cannot interleave with another writer, even
// one on a separate connection or process. `fn` must be synchronous. Called
// inside an open transaction, it joins that transaction instead of nesting.
export function runImmediate<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T {
  if (db.isTransaction) return fn(db);

  db.exec("BEGIN IMMEDIATE");
  let result: T;
  try {
    result = fn(db);
    if (result instanceof Promise) {
      throw new TypeError("immediate() callbacks must be synchronous");
    }
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.exec("COMMIT");
  return result;
}
