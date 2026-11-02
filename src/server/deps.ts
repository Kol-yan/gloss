import type { DatabaseSync } from "node:sqlite";

// Optional overrides shared by server functions. Production code passes
// nothing and gets the process database and the real clock; tests inject a
// scratch database and a fixed time.
export interface ServerDeps {
  db?: DatabaseSync;
  now?: Date;
}
