import { describe, expect, it } from "vitest";
import { parseSelectionFragment } from "@/features/capture/selection";
import { createSelectionStore } from "@/features/capture/selection-store";

describe("selected text import", () => {
  it("normalizes text and preserves literal markup as text", () => {
    expect(parseSelectionFragment("#" + new URLSearchParams({ text: "Cafe\u0301\r\n<img src=x>" }))).toEqual({
      status: "accepted", text: "Caf\u00e9\n<img src=x>",
    });
    expect(parseSelectionFragment("#content")).toBeNull();
  });

  it("rejects oversize text without truncation, and treats empty selections honestly", () => {
    expect(parseSelectionFragment("#text=" + "a".repeat(6001))).toEqual({ status: "too-long", text: "" });
    expect(parseSelectionFragment("#capture=too-long")).toEqual({ status: "too-long", text: "" });
    expect(parseSelectionFragment("#text=++")).toEqual({ status: "empty", text: "" });
  });

  it("clears the URL, survives first sign-in, and clears on an account change", () => {
    let hash = "#text=Selected+text";
    let learner: string | null = null;
    let onIdentity = () => {};
    let onHash = () => {};
    const store = createSelectionStore({
      fragment: () => hash,
      clearFragment: () => { hash = ""; },
      listenFragment: (callback) => { onHash = callback; return () => {}; },
      learner: () => learner,
      listenIdentity: (callback) => { onIdentity = callback; return () => {}; },
    });
    const stop = store.subscribe(() => {});
    expect(hash).toBe("");
    expect(store.getSnapshot().result?.text).toBe("Selected text");
    learner = "first";
    onIdentity();
    const first = store.getSnapshot();
    onIdentity();
    expect(store.getSnapshot()).toBe(first);
    learner = "second";
    onIdentity();
    expect(store.getSnapshot().result).toBeNull();
    hash = "#text=New+selection";
    onHash();
    expect(store.getSnapshot().result?.text).toBe("New selection");
    learner = null;
    onIdentity();
    expect(store.getSnapshot().result).toBeNull();
    stop();
  });
});
