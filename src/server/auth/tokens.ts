import { createHash, randomBytes } from "node:crypto";

// 32 random bytes as base64url: 43 characters, 256 bits of entropy.
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

// Only this hash is ever stored; a database leak does not reveal usable tokens.
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Cheap shape check so garbage input never reaches the database.
export function looksLikeToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
