import { DEFAULT_ORIGIN, parseAppOrigin } from "../capture.mjs";

// Everything the extension stores, all in storage.local on this device:
// - appOrigin: the learner's gloss server.
// - checksEnabled: writing checks in text fields, on unless switched off.
// - checksOffSites: host names where the learner turned writing checks off.
// No text, word list, page address or credential is ever stored.
export const DEFAULT_SETTINGS = Object.freeze({
  appOrigin: DEFAULT_ORIGIN,
  checksEnabled: true,
  checksOffSites: Object.freeze([]),
});

const MAX_OFF_SITES = 500;
// Host names as `location.hostname` reports them: lower-case ASCII (IDN in
// punycode), or a bracketed IPv6 address.
const HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/;

export function normalizeSite(value) {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  return host.length > 0 && host.length <= 253 && HOST.test(host) ? host : null;
}

// Stored values are checked again on every read: a broken or hand-edited
// value must fail closed (no server) rather than reach another address.
export function readSettings(stored) {
  const raw = stored && typeof stored === "object" ? stored : {};
  const sites = Array.isArray(raw.checksOffSites) ? raw.checksOffSites : [];
  return {
    appOrigin: raw.appOrigin === undefined ? DEFAULT_ORIGIN : parseAppOrigin(raw.appOrigin),
    checksEnabled: raw.checksEnabled !== false,
    checksOffSites: [...new Set(sites.map(normalizeSite).filter(Boolean))].slice(0, MAX_OFF_SITES),
  };
}

export function withSiteChecks(settings, site, off) {
  const host = normalizeSite(site);
  if (!host) return settings.checksOffSites;
  const rest = settings.checksOffSites.filter((entry) => entry !== host);
  return off ? [...rest, host].sort().slice(0, MAX_OFF_SITES) : rest;
}

// Whether writing checks run on a page. The gloss editor has its own checks,
// so the extension stays out of the configured server's own pages.
export function pageChecks(settings, page) {
  const host = normalizeSite(page?.host);
  const offHere = host !== null && settings.checksOffSites.includes(host);
  const isApp = settings.appOrigin !== null && page?.origin === settings.appOrigin;
  return {
    on: settings.checksEnabled && host !== null && !offHere && !isApp,
    offHere,
    globalOff: !settings.checksEnabled,
    isApp,
  };
}
