import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppHeader } from "@/components/app-header";
import { ExpressionsScreen } from "@/features/expressions/expressions-screen";
import ExpressionsPage from "@/app/expressions/page";
import WordsPage, { metadata } from "@/app/words/page";

vi.mock("next/navigation", () => ({ usePathname: () => "/words" }));

describe("My words section", () => {
  it("keeps the existing navigation URL and marks the words alias active", () => {
    const html = renderToStaticMarkup(createElement(AppHeader));
    expect(html).toMatch(/<a[^>]*href="\/expressions"[^>]*>My words<\/a>/);
    const wordsLink = html.match(/<a[^>]*href="\/expressions"[^>]*>/)?.[0];
    expect(wordsLink).toContain('aria-current="page"');
    expect(html).not.toContain("My expressions");
  });

  it("uses the words name in the empty state", () => {
    const html = renderToStaticMarkup(createElement(ExpressionsScreen, { items: [] }));
    expect(html).toContain("My words");
    expect(html).toContain("No words yet");
    expect(html).not.toContain("My expressions");
  });

  it("serves the existing section component at the words alias", () => {
    expect(WordsPage).toBe(ExpressionsPage);
    expect(metadata.title).toBe("My words");
  });
});
