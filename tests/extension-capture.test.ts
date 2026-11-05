import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADD_MENU_ID,
  buildCaptureUrl,
  DEFAULT_ORIGIN,
  MAX_SELECTION_LENGTH,
  MAX_WORD_LENGTH,
  MENU_ID,
  originPermission,
  parseAppOrigin,
  prepareWord,
  PRODUCTION_ORIGIN,
} from "../extension/capture.mjs";

describe("extension capture boundaries", () => {
  it("defaults to the hosted server for unpacked installations too", () => {
    expect(DEFAULT_ORIGIN).toBe("https://gloss.li");
    expect(PRODUCTION_ORIGIN).toBe("https://gloss.li");
  });

  it("keeps the hosted default when Chrome reports an unpacked manifest", async () => {
    vi.stubGlobal("chrome", { runtime: { getManifest: () => ({ manifest_version: 3 }) } });
    try {
      vi.resetModules();
      const capture = await import("../extension/capture.mjs");
      expect(capture.DEFAULT_ORIGIN).toBe("https://gloss.li");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps selected text in a fragment and does not include its source page", () => {
    const selected = "A phrase with & symbols # and a question?";
    const url = new URL(buildCaptureUrl(selected)!);
    expect(url.origin).toBe(DEFAULT_ORIGIN);
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("text")).toBe(selected);
  });

  it("preserves whitespace, normalizes accents and line endings, and keeps emoji intact", () => {
    const selected = "  café\r\n😀\rsecond line  ";
    const url = new URL(buildCaptureUrl(selected, "http://localhost:13320/")!);
    expect(new URLSearchParams(url.hash.slice(1)).get("text")).toBe("  café\n😀\nsecond line  ");
  });

  it("accepts the exact UTF-16 limit and rejects oversized text without exposing it", () => {
    const exact = "a".repeat(MAX_SELECTION_LENGTH - 2) + "😀";
    expect(new URLSearchParams(new URL(buildCaptureUrl(exact)!).hash.slice(1)).get("text")).toBe(exact);
    const tooLong = new URL(buildCaptureUrl(exact + "b")!);
    expect(tooLong.hash).toBe("#capture=too-long");
    expect(tooLong.href).not.toContain("aaa");
  });

  it("does nothing with empty selections", () => {
    for (const text of ["", " \r\n\t "]) expect(buildCaptureUrl(text)).toBeNull();
  });

  it("allows secure origins and HTTP loopback only", () => {
    expect(parseAppOrigin(" https://gloss.example/ ")).toBe("https://gloss.example");
    expect(parseAppOrigin("https://example.com:8443")).toBe("https://example.com:8443");
    expect(parseAppOrigin("http://127.0.0.1:3200")).toBe("http://127.0.0.1:3200");
    expect(parseAppOrigin("http://localhost:13320/")).toBe("http://localhost:13320");
    for (const origin of ["http://example.com", "javascript:alert(1)", "ftp://gloss.example", "gloss.example",
      "https://user:pass@gloss.example", "https://@gloss.example", "https://gloss.example/editor", "https://gloss.example/./",
      "https://gloss.example?", "https://gloss.example/#", "https://gloss.example?text=secret", "https://gloss.example/#text=secret",
      "https://glo\tss.example", "https://gloss.example\\", "https://gloss.example:invalid"]) {
      expect(parseAppOrigin(origin), origin).toBeNull();
      expect(buildCaptureUrl("Example", origin), origin).toBeNull();
    }
  });

  it("asks for a port-free host permission for the server origin only", () => {
    expect(originPermission("http://localhost:3000")).toBe("http://localhost/*");
    expect(originPermission("http://127.0.0.1:3200/")).toBe("http://127.0.0.1/*");
    expect(originPermission("https://gloss.example:8443")).toBe("https://gloss.example/*");
    expect(originPermission("http://example.com")).toBeNull();
    expect(originPermission(undefined)).toBeNull();
  });
});

describe("words for Add to My words", () => {
  it("keeps one line without the punctuation a selection picks up", () => {
    expect(prepareWord("  serendipity, ")).toEqual({ ok: true, text: "serendipity" });
    expect(prepareWord("“get the ball\n rolling.”")).toEqual({ ok: true, text: "get the ball rolling" });
    expect(prepareWord("(rock 'n' roll)")).toEqual({ ok: true, text: "rock 'n' roll" });
    expect(prepareWord("well-known")).toEqual({ ok: true, text: "well-known" });
    expect(prepareWord("café")).toEqual({ ok: true, text: "café" });
  });

  it("refuses empty, letterless and overlong selections", () => {
    for (const text of [undefined, "", "  ", "...", "2026", "— 42 —"]) {
      expect(prepareWord(text), String(text)).toEqual({ ok: false, reason: "empty" });
    }
    expect(prepareWord("a".repeat(MAX_WORD_LENGTH))).toEqual({ ok: true, text: "a".repeat(MAX_WORD_LENGTH) });
    expect(prepareWord("a".repeat(MAX_WORD_LENGTH + 1))).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("extension manifest", () => {
  const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));

  it("grants web access at installation without per-site prompts", () => {
    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(["contextMenus", "storage"]);
    // Checks run on HTTP(S) sites by default, with a per-site opt-out.
    expect([...manifest.host_permissions].sort()).toEqual(["http://*/*", "https://*/*"]);
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    for (const forbidden of ["history", "cookies", "webRequest", "scripting", "<all_urls>"]) {
      expect(JSON.stringify(manifest.permissions)).not.toContain(forbidden);
    }
  });

  it("runs content scripts in top frames of web pages only, with pure helpers loaded first", () => {
    expect(manifest.content_scripts).toHaveLength(1);
    const [script] = manifest.content_scripts;
    expect(script.matches).toEqual(["http://*/*", "https://*/*"]);
    expect(script.all_frames).toBeUndefined();
    expect(script.js[0]).toBe("content/words.js");
    expect(script.js.at(-1)).toBe("content/main.js");
    for (const file of [...script.js, ...(script.css ?? [])]) expect(() => readFileSync(`extension/${file}`)).not.toThrow();
  });

  it("uses a Chrome service worker without the Manifest V2 background scripts entry", () => {
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(manifest.browser_specific_settings.gecko.id).toMatch(/^\{[0-9a-f-]{36}\}$/);
    expect(manifest).not.toHaveProperty("web_accessible_resources");
    expect(manifest).not.toHaveProperty("externally_connectable");
  });
});

describe("extension background wiring", () => {
  type MenuInfo = { menuItemId: string; selectionText?: string; pageUrl?: string; frameId?: number };
  type Tab = { id: number; url?: string };
  let clicked: (info: MenuInfo, tab?: Tab) => void;
  let installed: () => Promise<void>;
  let onMessage: (message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean;
  const get = vi.fn();
  const createTab = vi.fn();
  const sendToTab = vi.fn();
  const openOptions = vi.fn();
  const createMenu = vi.fn();
  const contains = vi.fn();
  const setBadgeText = vi.fn();
  const fetchMock = vi.fn();
  const tab = { id: 7, url: "https://private.example/secret" };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  beforeEach(async () => {
    vi.resetModules();
    get.mockReset().mockImplementation(async (defaults: Record<string, unknown>) => ({ ...defaults, appOrigin: "http://localhost:13320" }));
    createTab.mockReset().mockResolvedValue({});
    sendToTab.mockReset().mockResolvedValue({ ok: true });
    openOptions.mockReset().mockResolvedValue(undefined);
    createMenu.mockReset().mockImplementation((_item, done) => done());
    contains.mockReset().mockResolvedValue(true);
    setBadgeText.mockReset().mockResolvedValue(undefined);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", {
      runtime: {
        id: "gloss-extension",
        lastError: undefined,
        openOptionsPage: openOptions,
        onInstalled: { addListener: (fn: typeof installed) => { installed = fn; } },
        onStartup: { addListener: () => undefined },
        onMessage: { addListener: (fn: typeof onMessage) => { onMessage = fn; } },
      },
      contextMenus: {
        removeAll: async () => undefined,
        create: createMenu,
        onClicked: { addListener: (fn: typeof clicked) => { clicked = fn; } },
      },
      storage: { local: { get }, onChanged: { addListener: () => undefined } },
      permissions: { contains },
      tabs: { create: createTab, sendMessage: sendToTab },
      action: {
        setBadgeText,
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setTitle: vi.fn().mockResolvedValue(undefined),
      },
    });
    await import("../extension/background.js");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("registers Add to My words and Check with gloss for selections only", async () => {
    await installed();
    expect(createMenu.mock.calls.map(([item]) => item)).toEqual([
      { id: ADD_MENU_ID, title: "Add to My words", contexts: ["selection"] },
      { id: MENU_ID, title: "Check with gloss", contexts: ["selection"] },
    ]);
  });

  it("opens only the encoded selection for Check with gloss", async () => {
    clicked({ menuItemId: MENU_ID, selectionText: "A sample", pageUrl: tab.url }, tab);
    await vi.waitFor(() => expect(createTab).toHaveBeenCalledOnce());
    expect(createTab.mock.calls[0][0]).toEqual({ url: "http://localhost:13320/#text=A+sample" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves a selected word with fetch and the session cookie, then shows a toast", async () => {
    fetchMock.mockResolvedValue(json({ expression: { id: "e1", text: "serendipity", meaning: "", familiarity: "new" }, created: true }));
    clicked({ menuItemId: ADD_MENU_ID, selectionText: " serendipity, ", pageUrl: tab.url }, tab);
    await vi.waitFor(() => expect(sendToTab).toHaveBeenCalledOnce());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:13320/api/expressions/capture");
    expect(init).toMatchObject({ method: "POST", credentials: "include", referrerPolicy: "no-referrer", redirect: "error" });
    expect(JSON.parse(init.body)).toEqual({ text: "serendipity" });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("private.example");
    expect(createTab).not.toHaveBeenCalled();
    expect(sendToTab.mock.calls[0]).toEqual([7, {
      type: "toast",
      toast: { tone: "success", text: "Added “serendipity” to My words.", word: "serendipity", canAddMeaning: true },
    }, { frameId: 0 }]);
  });

  it("reports a missing session without other details", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "unauthorized", message: "Please open your invite link to sign in." } }, 401));
    clicked({ menuItemId: ADD_MENU_ID, selectionText: "word" }, tab);
    await vi.waitFor(() => expect(sendToTab).toHaveBeenCalledOnce());
    expect(sendToTab.mock.calls[0][1].toast).toEqual({
      tone: "error",
      text: "Open gloss in this browser to start.",
      action: "app",
    });
  });

  it("sends nothing without host permission or a valid address", async () => {
    contains.mockResolvedValueOnce(false);
    clicked({ menuItemId: ADD_MENU_ID, selectionText: "word" }, tab);
    await vi.waitFor(() => expect(sendToTab).toHaveBeenCalledTimes(1));
    expect(sendToTab.mock.calls[0][1].toast.action).toBe("options");

    get.mockImplementationOnce(async (defaults: Record<string, unknown>) => ({ ...defaults, appOrigin: "http://remote.example" }));
    clicked({ menuItemId: ADD_MENU_ID, selectionText: "word" }, tab);
    await vi.waitFor(() => expect(sendToTab).toHaveBeenCalledTimes(2));
    expect(sendToTab.mock.calls[1][1].toast.text).toContain("server address");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a long selection before any request", async () => {
    clicked({ menuItemId: ADD_MENU_ID, selectionText: "word ".repeat(30) }, tab);
    await vi.waitFor(() => expect(sendToTab).toHaveBeenCalledOnce());
    expect(sendToTab.mock.calls[0][1].toast.text).toBe("Select a word or a short phrase (up to 80 characters).");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to a toolbar badge where the page has no content script", async () => {
    fetchMock.mockResolvedValue(json({ expression: { id: "e1", text: "word", meaning: "m", familiarity: "new" }, created: false }));
    sendToTab.mockRejectedValue(new Error("Receiving end does not exist."));
    clicked({ menuItemId: ADD_MENU_ID, selectionText: "word" }, tab);
    await vi.waitFor(() => expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "✓" }));
  });

  it("ignores unrelated actions and empty selections", async () => {
    clicked({ menuItemId: "another-action", selectionText: "A sample" }, tab);
    clicked({ menuItemId: MENU_ID, selectionText: " " }, tab);
    await Promise.resolve();
    expect(get).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it("opens settings without navigating text when settings are invalid or unavailable", async () => {
    for (const failure of ["invalid", "unavailable"]) {
      if (failure === "invalid") get.mockResolvedValueOnce({ appOrigin: "http://remote.example" });
      else get.mockRejectedValueOnce(new Error("Storage unavailable"));
      clicked({ menuItemId: MENU_ID, selectionText: "A private sample" }, tab);
      await vi.waitFor(() => expect(openOptions).toHaveBeenCalledTimes(failure === "invalid" ? 1 : 2));
    }
    expect(createTab).not.toHaveBeenCalled();
  });

  it("answers messages asynchronously and only from this extension", async () => {
    fetchMock.mockResolvedValue(json({ expressions: [{ expression: { id: "e1", text: "ubiquitous", meaning: "everywhere" } }] }));
    const respond = vi.fn();
    expect(onMessage({ type: "words" }, { id: "gloss-extension" }, respond)).toBe(true);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: true, words: [{ text: "ubiquitous", meaning: "everywhere" }] }));

    const stranger = vi.fn();
    onMessage({ type: "words" }, { id: "another-extension" }, stranger);
    await vi.waitFor(() => expect(stranger).toHaveBeenCalledWith({ ok: false, error: "invalid" }));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
