import type { AppConfig } from "../config";
import { guestClientIp } from "./guest";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function guestAccessAvailability(config: AppConfig): {
  siteKey: string | null;
  available: boolean;
  action?: string;
} {
  const hasSiteKey = Boolean(config.turnstile.siteKey);
  const hasSecretKey = Boolean(config.turnstile.secretKey);
  const unconfiguredDevelopment = process.env.NODE_ENV !== "production" && !hasSiteKey && !hasSecretKey;
  return {
    siteKey: config.turnstile.siteKey ?? null,
    available: unconfiguredDevelopment || (hasSiteKey && hasSecretKey),
    action: config.turnstile.action,
  };
}

// Cloudflare Siteverify is fail-closed. Development can omit Turnstile only
// when both keys are absent; partial production configuration never bypasses it.
export async function verifyGuestTurnstile(
  token: string | undefined,
  request: Request,
  config: AppConfig,
): Promise<boolean> {
  const { siteKey, secretKey, action, hostname } = config.turnstile;
  if (!siteKey && !secretKey && process.env.NODE_ENV !== "production") return true;
  if (!siteKey || !secretKey || !token || token.length > 2048) return false;

  const ip = guestClientIp(request, config);
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: secretKey, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (!response.ok) return false;
    const result: unknown = await response.json();
    if (result === null || typeof result !== "object") return false;
    const verification = result as { success?: unknown; action?: unknown; hostname?: unknown };
    return verification.success === true
      && (!action || verification.action === action)
      && (!hostname || verification.hostname === hostname);
  } catch {
    return false;
  }
}
