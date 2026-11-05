import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { checksRemaining } from "@/features/api/quota";
import { EditorScreen } from "@/features/editor/editor-screen";

describe("BYOK quota display", () => {
  it("hides unlimited usage and preserves hosted counters", () => {
    expect(checksRemaining({ used: 30, limit: 30, unlimited: true })).toBeNull();
    expect(checksRemaining({ used: 2, limit: 30 })).toBe(28);
    expect(checksRemaining({ used: 30, limit: 30 })).toBe(0);
  });
  it("does not retain an exhausted hosted counter for unlimited access", () => {
    const html = renderToStaticMarkup(createElement(EditorScreen, {
      checksLeft: 0, unlimitedChecks: true, initialCheckStatus: "quota",
      checkWithAi: async () => ({ ok: true as const, suggestions: [] }),
    }));
    expect(html).not.toContain("0 checks");
    expect(html).not.toContain("used up");
  });
});
