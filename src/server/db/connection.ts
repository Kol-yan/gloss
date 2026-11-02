import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getConfig } from "../config";
import { migrate } from "./migrate";
import { runImmediate } from "./transaction";

// Opens a connection with the standard pragmas and applies pending migrations.
// This is also the way tests open a fresh database at a temporary path.
export function openDatabase(filePath: string): DatabaseSync {
  const isMemory = filePath === ":memory:";
  // The path is operator configuration read at run time, not an app asset:
  // keep the bundler from tracing the whole project for it.
  const resolved = isMemory
    ? filePath
    : path.resolve(/*turbopackIgnore: true*/ process.cwd(), filePath);
  if (!isMemory) mkdirSync(/*turbopackIgnore: true*/ path.dirname(resolved), { recursive: true });

  // Several processes may open a fresh file at once (the first one switches
  // it to WAL). SQLite reports "database is locked" for that race without
  // consulting busy_timeout, so the whole open is retried.
  return retryWhileLocked(() => {
    const db = new DatabaseSync(resolved);
    try {
      // busy_timeout first: the later statements may have to wait for another
      // process holding the write lock.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      migrate(db);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  });
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

function retryWhileLocked<T>(fn: () => T, attempts = 100): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if ((code !== SQLITE_BUSY && code !== SQLITE_LOCKED) || attempt >= attempts) throw error;
      // Opening happens once per process, so a short blocking wait is fine.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

// One connection per server process. Kept on globalThis so dev-mode module
// reloads do not leak connections. Never called at import time: the database
// is opened by the first request that needs it.
const globalForDb = globalThis as typeof globalThis & { __glossyDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (!globalForDb.__glossyDb) {
    globalForDb.__glossyDb = openDatabase(getConfig().databasePath);
  }
  return globalForDb.__glossyDb;
}

export function closeDb(): void {
  globalForDb.__glossyDb?.close();
  globalForDb.__glossyDb = undefined;
}

// `BEGIN IMMEDIATE` helper bound to the process singleton by default; see
// runImmediate for the semantics.
export function immediate<T>(fn: (db: DatabaseSync) => T, db: DatabaseSync = getDb()): T {
  return runImmediate(db, fn);
}
