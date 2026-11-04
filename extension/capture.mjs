// The server is private and self-hosted, so the default is a local
// development server. Learners set their own address on the options page.
export const DEFAULT_ORIGIN = "http://localhost:3000";
export const MAX_SELECTION_LENGTH = 6000;
// The longest word or phrase "Add to gloss" saves; the server enforces the same.
export const MAX_WORD_LENGTH = 80;
export const MENU_ID = "gloss-check-selection";
export const ADD_MENU_ID = "gloss-add-word";

// Accept only an origin, so captured text cannot be redirected through a
// configured path, credentials or an existing query string.
export function parseAppOrigin(value) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  const match = /^(https?):\/\/([^/?#]+)\/?$/i.exec(input);
  if (!match || /[\u0000- \u007f\\]/.test(input) || match[2].includes("@")) return null;

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

// The host permission that lets the extension call this origin with the
// learner's session cookie. Ports are left out because browsers disagree on
// ports in match patterns; a port-free pattern matches every port of the host.
export function originPermission(origin) {
  const parsed = parseAppOrigin(origin);
  if (!parsed) return null;
  const url = new URL(parsed);
  return `${url.protocol}//${url.hostname}/*`;
}

export function normalizeSelection(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.normalize("NFC").replace(/\r\n?/g, "\n");
}

// Punctuation that a selection often picks up around a word ("serendipity,"
// or “quoted”). Inner punctuation such as "rock 'n' roll" is kept.
const EDGE_PUNCTUATION = /^[\s"'“”‘’«»()[\]{}<>.,;:!?…–—-]+|[\s"'“”‘’«»()[\]{}<>.,;:!?…–—-]+$/gu;

// Turns a selection into the word or phrase "Add to gloss" saves: one line,
// without surrounding punctuation, with at least one letter.
export function prepareWord(value) {
  const text = normalizeSelection(value);
  if (text === null) return { ok: false, reason: "empty" };
  const word = text.replace(/\s+/gu, " ").replace(EDGE_PUNCTUATION, "");
  if (!/\p{L}/u.test(word)) return { ok: false, reason: "empty" };
  if (word.length > MAX_WORD_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, text: word };
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
