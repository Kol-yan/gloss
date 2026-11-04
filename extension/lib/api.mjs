// Calls to the learner's gloss server. Requests carry the browser's gloss
// session cookie (credentials: "include") and nothing about the page they
// came from: no page address, title or referrer.

export const MAX_CHECK_LENGTH = 6000;
const DEFAULT_TIMEOUT_MS = 10_000;
// A cloud check waits for a model; the editor allows it the same patience.
const CHECK_TIMEOUT_MS = 45_000;
const CATEGORIES = new Set(["error", "style", "expression"]);

// Extension-level error codes. They name what the learner can do about it,
// not what the server said.
// - settings: no valid server address is saved.
// - not_allowed: the browser has not granted access to that address.
// - unreachable: the server did not answer.
// - signed_out: no gloss session in this browser.
// - quota: today's allowance for checks is used up.
// - paused: cloud checks are off or the server's daily budget is spent.
// - rate_limited, invalid, unavailable: try again later, or never for this input.
export function errorFromResponse(status, body) {
  const code = body?.error?.code;
  switch (code) {
    case "unauthorized": return "signed_out";
    case "quota_exceeded": return "quota";
    case "rate_limited": return "rate_limited";
    case "budget_exhausted":
    case "ai_disabled": return "paused";
    case "invalid_request": return "invalid";
    default: return status === 401 ? "signed_out" : "unavailable";
  }
}

const isText = (value) => typeof value === "string";
const isIndex = (value) => Number.isInteger(value) && value >= 0;

// Keeps only suggestions that can be placed in the checked text. Ranges are
// UTF-16 indices into the normalized text the server checked, and a
// suggestion applies only where that text still reads `original`.
export function readSuggestions(text, list) {
  if (!Array.isArray(list)) return [];
  return list.filter((s) =>
    s && isText(s.id) && s.id.length <= 100 && CATEGORIES.has(s.category)
    && isIndex(s.start) && isIndex(s.end) && s.end >= s.start && s.end <= text.length
    && isText(s.original) && isText(s.replacement) && isText(s.reason)
    && text.slice(s.start, s.end) === s.original,
  ).map((s) => ({
    id: s.id,
    category: s.category,
    start: s.start,
    end: s.end,
    original: s.original,
    replacement: s.replacement,
    reason: s.reason,
    meaningChange: s.meaningChange === true,
    meaning: isText(s.meaning) ? s.meaning : null,
  }));
}

export function readWords(body) {
  const items = Array.isArray(body?.expressions) ? body.expressions : [];
  const words = [];
  for (const item of items) {
    const expression = item?.expression;
    if (!isText(expression?.text) || !expression.text.trim()) continue;
    words.push({ text: expression.text, meaning: isText(expression.meaning) ? expression.meaning : "" });
  }
  return words;
}

// `resolveOrigin` answers { origin } or { error }, so a missing setting or
// permission is reported without a request.
export function createApi({ fetch, resolveOrigin, randomId }) {
  async function call(path, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const target = await resolveOrigin();
    if (!target.origin) return { ok: false, error: target.error ?? "settings" };

    let response;
    try {
      response = await fetch(`${target.origin}${path}`, {
        method,
        credentials: "include",
        cache: "no-store",
        // API routes never redirect; following one could leave the server.
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: body === undefined
          ? { Accept: "application/json" }
          : { Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, error: "unreachable" };
    }

    let json = null;
    try {
      json = await response.json();
    } catch {
      // Not a gloss answer; handled below by status.
    }
    if (!response.ok) return { ok: false, error: errorFromResponse(response.status, json) };
    if (json === null || typeof json !== "object") return { ok: false, error: "unavailable" };
    return { ok: true, data: json };
  }

  return {
    async me() {
      const result = await call("/api/me");
      if (!result.ok) return result;
      const quota = result.data.quotas?.proofread;
      return {
        ok: true,
        name: isText(result.data.learner?.displayName) ? result.data.learner.displayName : "",
        aiEnabled: result.data.aiEnabled === true,
        byok: result.data.accessMode === "byok",
        checks: quota && Number.isFinite(quota.used) && Number.isFinite(quota.limit)
          ? { used: quota.used, limit: quota.limit }
          : null,
      };
    },

    async listWords() {
      const result = await call("/api/expressions");
      return result.ok ? { ok: true, words: readWords(result.data) } : result;
    },

    async saveWord(text, meaning) {
      const result = await call("/api/expressions/capture", {
        method: "POST",
        body: meaning ? { text, meaning } : { text },
      });
      if (!result.ok) return result;
      const expression = result.data.expression;
      if (!isText(expression?.text)) return { ok: false, error: "unavailable" };
      return {
        ok: true,
        created: result.data.created === true,
        word: { text: expression.text, meaning: isText(expression.meaning) ? expression.meaning : "" },
      };
    },

    async check(text) {
      const result = await call("/api/proofread", {
        method: "POST",
        body: { requestId: randomId(), text },
        timeoutMs: CHECK_TIMEOUT_MS,
      });
      if (!result.ok) return result;
      if (!isText(result.data.textHash)) return { ok: false, error: "unavailable" };
      return {
        ok: true,
        textHash: result.data.textHash,
        suggestions: readSuggestions(text, result.data.suggestions),
      };
    },

    async decide(id, decision, textHash) {
      const result = await call(`/api/suggestions/${encodeURIComponent(id)}`, {
        method: "POST",
        body: { decision, textHash },
      });
      return result.ok ? { ok: true } : result;
    },
  };
}
