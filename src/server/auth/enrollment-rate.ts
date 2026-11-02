import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { RateLimitedError } from "../errors";

const WINDOW_MS = 60 * 60 * 1000;
const MAX_BUCKETS = 4096;

export function createEnrollmentLimiter() {
  const buckets = new Map<string, { count: number; expires: number }>();
  return (request: Request, trustProxyHeaders: boolean, now = Date.now()): void => {
    for (const [key, value] of buckets) if (value.expires <= now) buckets.delete(key);
    // Forwarded headers are untrusted unless the operator explicitly enabled a
    // proxy that overwrites them. Unknown clients share a conservative bucket.
    const forwarded = trustProxyHeaders ? request.headers.get("cf-connecting-ip")?.trim() : undefined;
    const ip = forwarded && isIP(forwarded) ? forwarded : null;
    const identity = ip ? createHash("sha256").update(ip).digest("hex") : "shared";
    const current = buckets.get(identity);
    const limit = ip ? 5 : 30;
    if ((current?.count ?? 0) >= limit || (!current && buckets.size >= MAX_BUCKETS)) throw new RateLimitedError();
    buckets.set(identity, { count: (current?.count ?? 0) + 1, expires: current?.expires ?? now + WINDOW_MS });
  };
}
