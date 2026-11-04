import { describe, expect, it, vi } from "vitest";
import { createApi, errorFromResponse, readSuggestions, readWords } from "../extension/lib/api.mjs";
import { createRouter, MAX_CHECKS_PER_MINUTE, saveToast, selectionToast } from "../extension/lib/router.mjs";
import { DEFAULT_SETTINGS, normalizeSite, pageChecks, readSettings, withSiteChecks } from "../extension/lib/settings.mjs";
import { accountLines, checksLine, highlightLine } from "../extension/lib/status.mjs";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const apiError = (code: string, status: number) => json({ error: { code, message: "Server text never shown." } }, status);
const HASH = "a".repeat(64);
const suggestion = (over: Record<string, unknown> = {}) => ({
  id: "s1", source: "ai", category: "error", start: 0, end: 3, original: "Thsi", replacement: "This",
  reason: "Spelling.", meaningChange: false, meaning: null, ...over,
});

describe("extension API client", () => {
  function setup(answer: Response | Error, origin: { origin?: string; error?: string } = { origin: "http://localhost:3000" }) {
    const fetch = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer.clone();
    });
    const api = createApi({ fetch, resolveOrigin: async () => origin, randomId: () => "11111111-1111-4111-8111-111111111111" });
    return { api, fetch };
  }

  it("maps server errors to what the learner can do about them", () => {
    expect(errorFromResponse(401, { error: { code: "unauthorized" } })).toBe("signed_out");
    expect(errorFromResponse(429, { error: { code: "quota_exceeded" } })).toBe("quota");
    expect(errorFromResponse(429, { error: { code: "rate_limited" } })).toBe("rate_limited");
    expect(errorFromResponse(503, { error: { code: "budget_exhausted" } })).toBe("paused");
    expect(errorFromResponse(503, { error: { code: "ai_disabled" } })).toBe("paused");
    expect(errorFromResponse(400, { error: { code: "invalid_request" } })).toBe("invalid");
    expect(errorFromResponse(401, null)).toBe("signed_out");
    expect(errorFromResponse(404, "<html>")).toBe("unavailable");
  });

  it("checks text with a fresh request id and keeps only suggestions that fit the text", async () => {
    const text = "Thsi is fine.";
    const { api, fetch } = setup(json({
      checkRunId: "r1", textHash: HASH, quota: { used: 1, limit: 20 },
      suggestions: [
        suggestion({ end: 4 }),
        suggestion({ id: "s2", start: 5, end: 7, original: "nope" }),
        suggestion({ id: "s3", start: 9, end: 99, original: "x" }),
        suggestion({ id: "s4", category: "unknown" }),
        { id: "s5" },
      ],
    }));
    const result = await api.check(text);
    expect(result).toEqual({ ok: true, textHash: HASH, suggestions: [expect.objectContaining({ id: "s1", start: 0, end: 4 })] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/proofread");
    expect(JSON.parse(String(init.body))).toEqual({ requestId: "11111111-1111-4111-8111-111111111111", text });
  });

  it("sends the session cookie and no page details", async () => {
    const { api, fetch } = setup(json({ expression: { text: "word", meaning: "" }, created: true }));
    await api.saveWord("word");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/expressions/capture");
    expect(init).toMatchObject({
      method: "POST", credentials: "include", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
    });
    expect(JSON.parse(String(init.body))).toEqual({ text: "word" });
    await api.saveWord("word", "a meaning");
    expect(JSON.parse(String((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ text: "word", meaning: "a meaning" });
  });

  it("makes no request without a server address or permission", async () => {
    for (const error of ["settings", "not_allowed"]) {
      const { api, fetch } = setup(json({}), { error });
      expect(await api.listWords()).toEqual({ ok: false, error });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("reports an unreachable or foreign server without details", async () => {
    expect(await setup(new TypeError("Failed to fetch")).api.me()).toEqual({ ok: false, error: "unreachable" });
    expect(await setup(new Response("<html>", { status: 200 })).api.me()).toEqual({ ok: false, error: "unavailable" });
    expect(await setup(apiError("quota_exceeded", 429)).api.check("Some text here.")).toEqual({ ok: false, error: "quota" });
  });

  it("reads the learner's status, words and decisions", async () => {
    const me = await setup(json({
      learner: { id: "l1", displayName: "Ana" }, accessMode: "hosted", aiEnabled: true,
      quotas: { proofread: { used: 3, limit: 20 } },
    })).api.me();
    expect(me).toEqual({ ok: true, name: "Ana", aiEnabled: true, byok: false, checks: { used: 3, limit: 20 } });

    expect(readWords({ expressions: [
      { expression: { text: "ubiquitous", meaning: "everywhere" } },
      { expression: { text: "  " } },
      { expression: { text: "no meaning" } },
      null,
    ] })).toEqual([{ text: "ubiquitous", meaning: "everywhere" }, { text: "no meaning", meaning: "" }]);
    expect(readWords(null)).toEqual([]);

    const { api, fetch } = setup(json({ id: "s/1", status: "accepted" }));
    expect(await api.decide("s/1", "accepted", HASH)).toEqual({ ok: true });
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("http://localhost:3000/api/suggestions/s%2F1");
  });

  it("drops suggestions whose text does not match", () => {
    expect(readSuggestions("abc", [suggestion({ start: 0, end: 3, original: "abc" })])).toHaveLength(1);
    expect(readSuggestions("abc", [suggestion({ start: 0, end: 3, original: "abd" })])).toEqual([]);
    expect(readSuggestions("abc", [suggestion({ start: 2, end: 1, original: "" })])).toEqual([]);
    expect(readSuggestions("abc", "nope")).toEqual([]);
  });
});

describe("extension message router", () => {
  const me = { id: "gloss-extension" };
  const settings = readSettings({ appOrigin: "http://localhost:3000", checksOffSites: ["news.example"] });

  function setup() {
    let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
    const api = {
      check: vi.fn(async (text: string) => ({ ok: true, textHash: HASH, suggestions: [suggestion({ original: text.slice(0, 3), end: 3 })] })),
      listWords: vi.fn(async () => ({ ok: true, words: [{ text: "word", meaning: "" }] })),
      saveWord: vi.fn(async (text: string) => ({ ok: true, created: true, word: { text, meaning: "" } })),
      decide: vi.fn(async () => ({ ok: true })),
      me: vi.fn(async () => ({ ok: true, name: "Ana" })),
    };
    const router = createRouter({ api, extensionId: me.id, getSettings: async () => settings, now: () => clock });
    return { api, router, advance: (ms: number) => { clock += ms; } };
  }

  it("answers only this extension and well-formed messages", async () => {
    const { router, api } = setup();
    expect(await router.handle({ type: "words" }, { id: "other" })).toEqual({ ok: false, error: "invalid" });
    expect(await router.handle({ type: "words" }, undefined)).toEqual({ ok: false, error: "invalid" });
    for (const message of [
      null, {}, { type: "nope" }, { type: "check" }, { type: "check", text: "" }, { type: "check", text: "a".repeat(6001) },
      { type: "decide", id: "s1", decision: "stale", textHash: HASH }, { type: "decide", id: "s1", decision: "accepted", textHash: "x" },
      { type: "save", text: "a".repeat(81) }, { type: "save", text: "word", meaning: "" },
    ]) {
      expect(await router.handle(message, me), JSON.stringify(message)).toEqual({ ok: false, error: "invalid" });
    }
    expect(api.check).not.toHaveBeenCalled();
    expect(api.saveWord).not.toHaveBeenCalled();
  });

  it("checks each text once and reuses the answer", async () => {
    const { router, api } = setup();
    const [first, second] = await Promise.all([
      router.handle({ type: "check", text: "Thsi is it." }, me),
      router.handle({ type: "check", text: "Thsi is it." }, me),
    ]);
    expect(first).toEqual(second);
    expect(await router.handle({ type: "check", text: "Thsi is it." }, me)).toEqual(first);
    expect(api.check).toHaveBeenCalledOnce();
  });

  it(`caps automatic checks at ${MAX_CHECKS_PER_MINUTE} a minute`, async () => {
    const { router, api, advance } = setup();
    for (let i = 0; i < MAX_CHECKS_PER_MINUTE; i += 1) {
      expect((await router.handle({ type: "check", text: `Text number ${i}.` }, me)).ok).toBe(true);
    }
    expect(await router.handle({ type: "check", text: "One more text." }, me)).toEqual({ ok: false, error: "busy", notice: null });
    advance(60_000);
    expect((await router.handle({ type: "check", text: "One more text." }, me)).ok).toBe(true);
    expect(api.check).toHaveBeenCalledTimes(MAX_CHECKS_PER_MINUTE + 1);
  });

  it("pauses after quota and session errors and tells the learner once", async () => {
    const { router, api, advance } = setup();
    api.check.mockResolvedValueOnce({ ok: false, error: "quota" } as never);
    const first = await router.handle({ type: "check", text: "First text here." }, me);
    expect(first).toEqual({ ok: false, error: "quota", notice: "Today's writing checks are used up. They start again at midnight UTC." });
    expect(await router.handle({ type: "check", text: "Second text here." }, me)).toEqual({ ok: false, error: "quota", notice: null });
    advance(11 * 3600_000);
    expect((await router.handle({ type: "check", text: "Second text here." }, me)).ok).toBe(false);
    advance(3600_000);
    expect((await router.handle({ type: "check", text: "Second text here." }, me)).ok).toBe(true);

    api.check.mockResolvedValueOnce({ ok: false, error: "signed_out" } as never);
    expect((await router.handle({ type: "check", text: "Third text here." }, me)).notice).toContain("Sign in");
    advance(61_000);
    api.check.mockResolvedValueOnce({ ok: false, error: "signed_out" } as never);
    // Once the pause is over the check is tried again, but the same problem is not announced twice.
    expect((await router.handle({ type: "check", text: "Third text here." }, me)).notice).toBeNull();
    expect(api.check).toHaveBeenCalledTimes(4);
  });

  it("starts over when settings change", async () => {
    const { router, api } = setup();
    api.check.mockResolvedValueOnce({ ok: false, error: "not_allowed" } as never);
    await router.handle({ type: "check", text: "Some text here." }, me);
    router.reset();
    expect((await router.handle({ type: "check", text: "Some text here." }, me)).ok).toBe(true);
  });

  it("caches the word list until a word is saved", async () => {
    const { router, api, advance } = setup();
    await router.handle({ type: "words" }, me);
    await router.handle({ type: "words" }, me);
    expect(api.listWords).toHaveBeenCalledOnce();
    expect(await router.handle({ type: "save", text: "new word" }, me)).toMatchObject({ ok: true, toast: { tone: "success" } });
    await router.handle({ type: "words" }, me);
    expect(api.listWords).toHaveBeenCalledTimes(2);
    advance(3 * 60_000);
    await router.handle({ type: "words" }, me);
    expect(api.listWords).toHaveBeenCalledTimes(3);
    await router.handle({ type: "words", force: true }, me);
    expect(api.listWords).toHaveBeenCalledTimes(4);
  });

  it("records decisions and tells pages whether to check", async () => {
    const { router, api } = setup();
    expect(await router.handle({ type: "decide", id: "s1", decision: "rejected", textHash: HASH }, me)).toEqual({ ok: true });
    expect(api.decide).toHaveBeenCalledWith("s1", "rejected", HASH);
    expect(await router.handle({ type: "page", host: "News.Example", origin: "https://news.example" }, me)).toEqual({
      ok: true, checks: { on: false, offHere: true, globalOff: false, isApp: false },
    });
    expect((await router.handle({ type: "page", host: "localhost", origin: "http://localhost:3000" }, me))).toMatchObject({
      checks: { on: false, isApp: true },
    });
    expect((await router.handle({ type: "page", host: "mail.example", origin: "https://mail.example" }, me))).toMatchObject({
      checks: { on: true },
    });
  });
});

describe("extension toasts and status lines", () => {
  it("words toasts in plain language", () => {
    expect(saveToast({ ok: true, created: true, word: { text: "word", meaning: "" } }, "word")).toEqual({
      tone: "success", text: "Added “word” to My words.", word: "word", canAddMeaning: true,
    });
    expect(saveToast({ ok: true, created: false, word: { text: "Word", meaning: "m" } }, "word")).toEqual({
      tone: "info", text: "“Word” is already in My words.", word: "Word", canAddMeaning: false,
    });
    expect(saveToast({ ok: false, error: "unreachable" }, "word").text).toContain("Could not reach");
    expect(saveToast({ ok: false, error: "whatever" }, "word")).toEqual({ tone: "error", text: "Could not save the word. Please try again." });
    expect(selectionToast("empty").text).toBe("Select a word or a short phrase to add.");
  });

  it("describes the account, highlighting and checks", () => {
    expect(accountLines({ ok: true, name: "Ana", aiEnabled: true, byok: false, checks: { used: 25, limit: 20 } }).text)
      .toBe("Signed in as Ana · 0 of 20 checks left today");
    expect(accountLines({ ok: true, name: "", aiEnabled: true, byok: true, checks: null }).note).toContain("own key");
    // Signed out is never a dead end: one button opens the site, which starts
    // a workspace, and no line ever asks for an invite.
    const signedOut = accountLines({ ok: false, error: "signed_out" });
    expect(signedOut).toMatchObject({ openApp: true });
    expect(signedOut.text).not.toMatch(/invite|not signed in/i);
    expect(accountLines({ ok: false, error: "strange" }).text).toContain("not available");
    expect(highlightLine({ on: true, matches: 1, words: 3 })).toBe("1 of your words is marked on this page.");
    expect(highlightLine({ on: true, matches: 4, words: 3 })).toBe("4 of your words are marked on this page.");
    expect(highlightLine({ on: true, matches: 0, words: 0 })).toContain("My words is empty");
    expect(highlightLine({ on: false, error: "unsupported" })).toContain("cannot highlight");
    expect(checksLine({ on: false, offHere: false, globalOff: true, isApp: false })).toContain("off on all sites");
    expect(checksLine(null)).toBe("");
  });
});

describe("extension settings", () => {
  it("fails closed on a stored address that is not valid", () => {
    expect(readSettings(undefined)).toEqual({ appOrigin: DEFAULT_SETTINGS.appOrigin, checksEnabled: true, checksOffSites: [] });
    expect(readSettings({ appOrigin: "http://remote.example" }).appOrigin).toBeNull();
    expect(readSettings({ checksEnabled: "false" }).checksEnabled).toBe(true);
    expect(readSettings({ checksEnabled: false }).checksEnabled).toBe(false);
    expect(readSettings({ checksOffSites: ["A.example.", "a.example", 4, "bad host", "[::1]"] }).checksOffSites)
      .toEqual(["a.example", "[::1]"]);
  });

  it("turns checks off and on per host name", () => {
    const settings = readSettings({});
    const off = withSiteChecks(settings, "Mail.Example", true);
    expect(off).toEqual(["mail.example"]);
    expect(withSiteChecks({ ...settings, checksOffSites: off }, "mail.example", false)).toEqual([]);
    expect(withSiteChecks(settings, "not a host", true)).toEqual([]);
    expect(normalizeSite("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    expect(normalizeSite("")).toBeNull();
  });

  it("keeps checks off on the gloss server's own pages and when switched off", () => {
    const settings = readSettings({ appOrigin: "https://gloss.example" });
    expect(pageChecks(settings, { host: "gloss.example", origin: "https://gloss.example" }).on).toBe(false);
    expect(pageChecks(settings, { host: "docs.example", origin: "https://docs.example" }).on).toBe(true);
    expect(pageChecks({ ...settings, checksEnabled: false }, { host: "docs.example", origin: "https://docs.example" }))
      .toEqual({ on: false, offHere: false, globalOff: true, isApp: false });
    expect(pageChecks(settings, { host: "", origin: "null" }).on).toBe(false);
  });
});
