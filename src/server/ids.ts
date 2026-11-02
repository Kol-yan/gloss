import { randomUUID } from "node:crypto";

// Opaque primary key for rows created by the server.
export function newId(): string {
  return randomUUID();
}
