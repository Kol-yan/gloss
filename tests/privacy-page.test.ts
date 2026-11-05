import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage, { metadata } from "@/app/privacy/page";
import { startsNoSession } from "@/components/invite-required";

describe("privacy page", () => {
  const html = renderToStaticMarkup(createElement(PrivacyPage));

  it("covers the website, the extension and the desktop app", () => {
    expect(metadata.title).toBe("Privacy");
    for (const heading of ["In short", "Your workspace", "AI models and your own key", "Website", "Browser extension", "Desktop app", "Your choices"]) {
      expect(html).toContain(`>${heading}</h2>`);
    }
  });

  it("names model providers in general terms and explains guest and own-key access", () => {
    expect(html).toContain("Third-party AI model providers process the text to return suggestions");
    expect(html).toContain("Free guest access:");
    expect(html).toContain("Your own OpenRouter key:");
    expect(html).toContain("never saved on the server");
  });

  it("does not start a guest workspace for a reader of the policy", () => {
    expect(startsNoSession("/privacy")).toBe(true);
    expect(startsNoSession("/join/abc")).toBe(true);
    expect(startsNoSession("/")).toBe(false);
    expect(startsNoSession("/editor")).toBe(false);
  });
});
