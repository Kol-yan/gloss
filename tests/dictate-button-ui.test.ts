import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DictateButton } from "@/features/editor/dictate-button";
import { EditorScreen } from "@/features/editor/editor-screen";

const dictate = async () => ({ ok: true as const, text: "" });

describe("dictate button", () => {
  it("renders an idle Dictate toggle with an empty status", () => {
    const html = renderToStaticMarkup(createElement(DictateButton, { dictate, onText: () => {} }));
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(">Dictate</button>");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("is disabled while cloud features are unavailable", () => {
    const html = renderToStaticMarkup(createElement(DictateButton, { dictate, disabled: true, onText: () => {} }));
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("appears in the editor only when voice input is wired", () => {
    expect(renderToStaticMarkup(createElement(EditorScreen, {}))).not.toContain(">Dictate</button>");
    expect(renderToStaticMarkup(createElement(EditorScreen, { dictate }))).toContain(">Dictate</button>");
  });
});
