import { getConfig } from "../config";

// Is this POST a same-origin request from our own page? An invite is redeemed
// by a form POST, which makes it a login-CSRF target: without a check, any
// site could sign a visitor into an account the attacker controls (an invite
// they hold) and then read what the visitor writes there.
//
// Browsers label the request's relationship to the page in `Sec-Fetch-Site`
// and send `Origin` on form POSTs. `Sec-Fetch-Site` may be absent (old
// browsers, scripts), but when present it must say same-origin. When `Origin`
// is present it must be one of this server's own origins.
export function isSameOriginPost(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;

  const origin = request.headers.get("origin");
  if (origin === null) return true;
  return ownOrigins(request).has(origin);
}

// The origins this server answers on. Behind a proxy the URL Next sees can
// differ from the one the browser used (scheme, host), so the forwarded
// headers and the configured public URL count too. A cross-site page cannot
// forge `Origin`, so trusting these headers does not weaken the check.
function ownOrigins(request: Request): Set<string> {
  const origins = new Set<string>();
  const url = new URL(request.url);
  origins.add(url.origin);

  const first = (name: string) => request.headers.get(name)?.split(",")[0]?.trim() || null;
  const host = first("x-forwarded-host") ?? request.headers.get("host");
  const proto = first("x-forwarded-proto") ?? url.protocol.replace(":", "");
  if (host) origins.add(`${proto}://${host}`);

  try {
    origins.add(new URL(getConfig().publicUrl).origin);
  } catch {
    // An unusable configuration still leaves the request's own origin.
  }
  return origins;
}
