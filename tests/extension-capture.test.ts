import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCaptureUrl, DEFAULT_ORIGIN, MAX_SELECTION_LENGTH, MENU_ID, parseAppOrigin } from "../extension/capture.mjs";

describe("extension capture boundaries", () => {
  it("keeps selected text in a fragment and does not include its source page", () => {
    const selected = "A phrase with & symbols # and a question?";
    const url = new URL(buildCaptureUrl(selected)!);
    expect(url.origin).toBe(DEFAULT_ORIGIN);
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("text")).toBe(selected);
  });

  it("preserves whitespace, normalizes accents and line endings, and keeps emoji intact", () => {
    const selected = "  cafe\u0301\r\n\ud83d\ude00\rsecond line  ";
    const url = new URL(buildCaptureUrl(selected, "http://localhost:13320/")!);
    expect(new URLSearchParams(url.hash.slice(1)).get("text")).toBe("  caf\u00e9\n\ud83d\ude00\nsecond line  ");
  });

  it("accepts the exact UTF-16 limit and rejects oversized text without exposing it", () => {
    const exact = "a".repeat(MAX_SELECTION_LENGTH - 2) + "\ud83d\ude00";
    expect(new URLSearchParams(new URL(buildCaptureUrl(exact)!).hash.slice(1)).get("text")).toBe(exact);
    const tooLong = new URL(buildCaptureUrl(exact + "b")!);
    expect(tooLong.hash).toBe("#capture=too-long");
    expect(tooLong.href).not.toContain("aaa");
  });

  it("does nothing with empty selections", () => {
    for (const text of ["", " \r\n\t "]) expect(buildCaptureUrl(text)).toBeNull();
  });

  it("allows secure origins and HTTP loopback only", () => {
    expect(parseAppOrigin(" https://gloss.li/ ")).toBe("https://gloss.li");
    expect(parseAppOrigin("https://example.com:8443")).toBe("https://example.com:8443");
    expect(parseAppOrigin("http://127.0.0.1:3200")).toBe("http://127.0.0.1:3200");
    expect(parseAppOrigin("http://localhost:13320/")).toBe("http://localhost:13320");
    for (const origin of ["http://example.com", "javascript:alert(1)", "ftp://gloss.li", "gloss.li",
      "https://user:pass@gloss.li", "https://@gloss.li", "https://gloss.li/editor", "https://gloss.li/./",
      "https://gloss.li?", "https://gloss.li/#", "https://gloss.li?text=secret", "https://gloss.li/#text=secret",
      "https://glo\tss.li", "https://gloss.li\\", "https://gloss.li:invalid"]) {
      expect(parseAppOrigin(origin), origin).toBeNull();
      expect(buildCaptureUrl("Example", origin), origin).toBeNull();
    }
  });

  it("declares only menu and local-setting permissions", () => {
    const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
    expect(manifest.permissions.sort()).toEqual(["contextMenus", "storage"]);
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest.background.type).toBe("module");
  });
});

describe("extension action wiring", () => {
  let clicked: (info: { menuItemId: string; selectionText?: string; pageUrl?: string }) => void;
  let installed: () => void;
  const get = vi.fn();
  const createTab = vi.fn();
  const openOptions = vi.fn();
  const createMenu = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    get.mockReset().mockResolvedValue({ appOrigin: "http://localhost:13320" });
    createTab.mockReset().mockResolvedValue({});
    openOptions.mockReset().mockResolvedValue(undefined);
    createMenu.mockReset().mockImplementation((_item, done) => done());
    vi.stubGlobal("chrome", {
      runtime: { lastError: undefined, openOptionsPage: openOptions, onInstalled: { addListener: (fn: () => void) => { installed = fn; } } },
      contextMenus: { removeAll: (done: () => void) => done(), create: createMenu,
        onClicked: { addListener: (fn: typeof clicked) => { clicked = fn; } } },
      storage: { local: { get } }, tabs: { create: createTab },
    });
    await import("../extension/background.js");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("registers a selection-only menu and opens only the encoded selection", async () => {
    installed();
    expect(createMenu.mock.calls[0][0]).toMatchObject({ contexts: ["selection"], id: MENU_ID });
    clicked({ menuItemId: MENU_ID, selectionText: "A sample", pageUrl: "https://private.example/secret" });
    await vi.waitFor(() => expect(createTab).toHaveBeenCalledOnce());
    expect(createTab.mock.calls[0][0]).toEqual({ url: "http://localhost:13320/#text=A+sample" });
  });

  it("ignores unrelated actions and empty selections", async () => {
    clicked({ menuItemId: "another-action", selectionText: "A sample" });
    clicked({ menuItemId: MENU_ID, selectionText: " " });
    await Promise.resolve();
    expect(get).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it("opens settings without navigating text when settings are invalid or unavailable", async () => {
    for (const failure of ["invalid", "unavailable"]) {
      if (failure === "invalid") get.mockResolvedValueOnce({ appOrigin: "http://remote.example" });
      else get.mockRejectedValueOnce(new Error("Storage unavailable"));
      clicked({ menuItemId: MENU_ID, selectionText: "A private sample" });
      await vi.waitFor(() => expect(openOptions).toHaveBeenCalledTimes(failure === "invalid" ? 1 : 2));
    }
    expect(createTab).not.toHaveBeenCalled();
  });
});
