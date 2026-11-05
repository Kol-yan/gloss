import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureEditorHref } from "@/features/landing/capture-handoff";
import { Landing } from "@/features/landing/landing";
import { LandingFlow } from "@/features/landing/landing-flow";
import { AppHeader } from "@/components/app-header";
import { UnauthorizedError } from "@/server/errors";

const mocks = vi.hoisted(() => ({ learner: vi.fn(), completed: vi.fn(), pathname: "/" }));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
vi.mock("@/server/auth/request", () => ({ requireLearner: mocks.learner }));
vi.mock("@/server/learning/onboarding/completion", () => ({ hasCompletedOnboarding: mocks.completed }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname, useRouter: () => ({ replace: vi.fn() }) }));

beforeEach(() => { vi.clearAllMocks(); mocks.pathname = "/"; });

describe("landing and editor navigation", () => {
  it("hands legacy captures to the editor without moving text into a query", () => {
    const href = captureEditorHref("#text=Some+private+text&untrusted=ignored");
    expect(href).toBe("/editor#text=Some+private+text");
    expect(captureEditorHref("#capture=too-long")).toBe("/editor#capture=too-long");
    expect(captureEditorHref("#text=" + "a".repeat(6001))).toBe("/editor#capture=too-long");
    expect(captureEditorHref("#tools")).toBeNull();
    expect(captureEditorHref("")).toBeNull();
  });

  it("renders the headline, living line, actions, three tool rows and GitHub footer", () => {
    const html = renderToStaticMarkup(createElement(Landing, { startPracticeHref: "/onboarding" }));
    expect(html).toContain("Write it right. Then make the words your own.");
    expect(html).toContain('href="/onboarding"');
    expect(html).toContain('href="#tools"');
    expect(html).toContain('id="tools"');
    expect(html).toContain("Start practising");
    expect(html).toContain("Get the tools");
    expect(html).toContain('class="word-line word-line-welcome"');
    expect(html).toContain('href="/editor"');
    expect(html).toContain("Chrome extension");
    expect(html).toContain("Mac app");
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain('href="https://github.com/Kol-yan/gloss#desktop-app"');
    expect(html).toContain('href="https://github.com/Kol-yan/gloss">GitHub');
  });

  it("sends new visitors and unfinished learners to onboarding", async () => {
    mocks.learner.mockRejectedValueOnce(new UnauthorizedError());
    expect((await LandingFlow()).props.startPracticeHref).toBe("/onboarding");
    mocks.learner.mockResolvedValueOnce({ id: "learner" });
    mocks.completed.mockReturnValueOnce(false);
    expect((await LandingFlow()).props.startPracticeHref).toBe("/onboarding");
    expect(mocks.completed).toHaveBeenCalledWith("learner");
  });

  it("sends completed learners to practice and propagates unexpected failures", async () => {
    mocks.learner.mockResolvedValueOnce({ id: "learner" });
    mocks.completed.mockReturnValueOnce(true);
    expect((await LandingFlow()).props.startPracticeHref).toBe("/practice");
    mocks.learner.mockRejectedValueOnce(new Error("unavailable"));
    await expect(LandingFlow()).rejects.toThrow("unavailable");
  });

  it("keeps the landing header quiet and links the application editor tab to /editor", () => {
    expect(renderToStaticMarkup(createElement(AppHeader))).toBe("");
    mocks.pathname = "/editor";
    const html = renderToStaticMarkup(createElement(AppHeader));
    expect(html).toMatch(/<a(?=[^>]*href="\/editor")(?=[^>]*aria-current="page")[^>]*>/);
  });
});
