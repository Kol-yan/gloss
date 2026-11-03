export const DEFAULT_ORIGIN = "https://gloss.li";
export const MAX_SELECTION_LENGTH = 6000;
export const MENU_ID = "gloss-check-selection";

// Accept only an origin, so captured text cannot be redirected through a
// configured path, credentials or an existing query string.
export function parseAppOrigin(value) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  const match = /^(https?):\/\/([^/?#]+)\/?$/i.exec(input);
  if (!match || /[\u0000-\u0020\u007f\\]/.test(input) || match[2].includes("@")) return null;

  try {
    const url = new URL(input);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function normalizeSelection(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.normalize("NFC").replace(/\r\n?/g, "\n");
}

export function buildCaptureUrl(selection, appOrigin = DEFAULT_ORIGIN) {
  const origin = parseAppOrigin(appOrigin);
  const text = normalizeSelection(selection);
  if (!origin || text === null) return null;

  // Reject rather than silently truncate a selection, especially around emoji
  // and sentence boundaries. The editor explains this fragment to the learner.
  const fragment = new URLSearchParams(text.length > MAX_SELECTION_LENGTH
    ? { capture: "too-long" }
    : { text });
  return `${origin}/#${fragment.toString()}`;
}
