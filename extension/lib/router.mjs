import { MAX_CHECK_LENGTH } from "./api.mjs";
import { pageChecks } from "./settings.mjs";

// Messages from this extension's content scripts and pages, answered by the
// background. The background is the only part that talks to the server:
// content scripts run inside web pages, whose CORS rules would apply to them.

const WORDS_TTL_MS = 2 * 60_000;
const CHECK_CACHE_SIZE = 40;
// Automatic checks spend the learner's daily proofreading quota, so the
// background caps them however many tabs or fields are busy.
export const MAX_CHECKS_PER_MINUTE = 6;
// After one of these errors no check is sent for a while: the answer would
// be the same, and each attempt may cost quota.
const PAUSE_MS = {
  signed_out: 60_000,
  settings: 30_000,
  not_allowed: 30_000,
  unreachable: 30_000,
  rate_limited: 60_000,
  paused: 10 * 60_000,
};
// A learner hears about the same problem at most this often.
const NOTIFY_EVERY_MS = 30 * 60_000;
const DECISIONS = new Set(["accepted", "rejected"]);
const HASH = /^[a-f0-9]{64}$/;

const isText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

function nextUtcMidnight(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

const SAVE_ERRORS = {
  settings: { text: "Set your gloss server address in the extension settings.", action: "options" },
  not_allowed: { text: "Allow gloss to reach your server in the extension settings.", action: "options" },
  unreachable: { text: "Could not reach your gloss server. Check that it is running." },
  signed_out: { text: "Open gloss in this browser to start.", action: "app" },
  invalid: { text: "Select a word or a short phrase to add." },
};

// What the page shows after "Add to My words". Learner-facing, short, and never
// a raw server message.
export function saveToast(result, word) {
  if (result.ok) {
    const text = result.word?.text ?? word;
    return result.created
      ? { tone: "success", text: `Added “${text}” to My words.`, word: text, canAddMeaning: !result.word?.meaning }
      : { tone: "info", text: `“${text}” is already in My words.`, word: text, canAddMeaning: !result.word?.meaning };
  }
  const known = SAVE_ERRORS[result.error];
  return known
    ? { tone: "error", ...known }
    : { tone: "error", text: "Could not save the word. Please try again." };
}

export function selectionToast(reason) {
  return reason === "too_long"
    ? { tone: "error", text: "Select a word or a short phrase (up to 80 characters)." }
    : { tone: "error", text: "Select a word or a short phrase to add." };
}

const CHECK_NOTICES = {
  signed_out: "Open gloss in this browser to start.",
  quota: "Today's writing checks are used up. They start again at midnight UTC.",
  paused: "Cloud writing checks are paused right now.",
  not_allowed: "Allow gloss to reach your server in the extension settings.",
};

export function createRouter({ api, extensionId, getSettings, now = () => Date.now() }) {
  let words = null;
  let wordsAt = 0;
  let wordsPending = null;
  const checks = new Map();
  const inflight = new Map();
  const sent = [];
  let pause = null;
  const notified = new Map();

  function notice(error) {
    const text = CHECK_NOTICES[error];
    if (!text) return null;
    const last = notified.get(error);
    if (last !== undefined && now() - last < NOTIFY_EVERY_MS) return null;
    notified.set(error, now());
    return text;
  }

  function fail(error) {
    if (error === "quota") pause = { error, until: nextUtcMidnight(now()) };
    else if (PAUSE_MS[error]) pause = { error, until: now() + PAUSE_MS[error] };
    return { ok: false, error, notice: notice(error) };
  }

  async function loadWords(force) {
    if (!force && words && now() - wordsAt < WORDS_TTL_MS) return { ok: true, words };
    wordsPending ??= api.listWords().finally(() => { wordsPending = null; });
    const result = await wordsPending;
    if (result.ok) {
      words = result.words;
      wordsAt = now();
    }
    return result;
  }

  async function check(text) {
    const cached = checks.get(text);
    if (cached) return cached;
    if (inflight.has(text)) return inflight.get(text);
    if (pause && now() < pause.until) return { ok: false, error: pause.error, notice: null };
    pause = null;
    while (sent.length && now() - sent[0] >= 60_000) sent.shift();
    if (sent.length >= MAX_CHECKS_PER_MINUTE) return { ok: false, error: "busy", notice: null };
    sent.push(now());

    const pending = api.check(text).then((result) => {
      if (!result.ok) return fail(result.error);
      const answer = { ok: true, textHash: result.textHash, suggestions: result.suggestions };
      checks.set(text, answer);
      if (checks.size > CHECK_CACHE_SIZE) checks.delete(checks.keys().next().value);
      return answer;
    }).finally(() => inflight.delete(text));
    inflight.set(text, pending);
    return pending;
  }

  async function handle(message, sender) {
    if (!sender || sender.id !== extensionId || !message || typeof message.type !== "string") {
      return { ok: false, error: "invalid" };
    }
    switch (message.type) {
      case "words":
        return loadWords(message.force === true);
      case "check":
        if (!isText(message.text, MAX_CHECK_LENGTH)) return { ok: false, error: "invalid" };
        return check(message.text);
      case "decide":
        if (!isText(message.id, 100) || !DECISIONS.has(message.decision) || !HASH.test(message.textHash ?? "")) {
          return { ok: false, error: "invalid" };
        }
        return api.decide(message.id, message.decision, message.textHash);
      case "save": {
        if (!isText(message.text, 80) || (message.meaning !== undefined && !isText(message.meaning, 200))) {
          return { ok: false, error: "invalid" };
        }
        const result = await api.saveWord(message.text, message.meaning);
        if (result.ok) words = null;
        return { ...result, toast: message.meaning ? null : saveToast(result, message.text) };
      }
      case "status":
        return api.me();
      case "page":
        return { ok: true, checks: pageChecks(await getSettings(), { host: message.host, origin: message.origin }) };
      default:
        return { ok: false, error: "invalid" };
    }
  }

  return {
    handle,
    // A saved word must show up the next time a page asks for the list.
    forgetWords() { words = null; },
    // New settings may fix what an earlier error reported.
    reset() {
      pause = null;
      words = null;
      checks.clear();
      notified.clear();
    },
  };
}
