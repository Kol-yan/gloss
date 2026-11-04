import path from "node:path";
import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { joinAsNewLearner } from "./fixtures";
import { createFixturePracticeClient } from "@/lib/practice-session-fixtures";

async function shot(page: Page, name: string, size: string) {
  const dir = process.env.GLOSS_ONBOARDING_SHOTS;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${size}-${name}.png`) });
  }
  const fits = await page.locator(".onb-next").evaluate(el => {
    const rect = el.getBoundingClientRect();
    return rect.bottom <= innerHeight && rect.right <= innerWidth;
  });
  expect(fits).toBe(true);
  expect(await page.locator("body").evaluate(el => el.scrollWidth <= innerWidth)).toBe(true);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const size = `${viewport.width}x${viewport.height}`;
  test(`all six steps lead to the first practice, ${size}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "light" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await joinAsNewLearner(page);
    await expect(page.getByRole("heading", { name: "Nice to meet you." })).toHaveCount(0);
    await page.goto("/expressions");
    await expect(page).toHaveURL("/expressions");
    await page.goto("/practice");
    await expect(page).toHaveURL("/onboarding");
    await expect(page.getByRole("heading", { name: "Nice to meet you." })).toBeVisible();
    await expect(page.locator(".wl-dot")).toHaveCount(44);
    await expect(page.locator(".wl-word").first()).toBeVisible();
    await shot(page, "01-welcome", size);
    await page.getByRole("button", { name: "Get started" }).click();
    await expect(page.getByRole("heading", { name: "What's your English level?" })).toBeVisible();
    await shot(page, "02-level", size);
    await page.getByRole("radio", { name: "Advanced" }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("progressbar", { name: "Word check progress" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
    for (let i = 0; i < 24; i++) {
      const response = page.waitForResponse(res => res.url().endsWith("/api/onboarding/word-check") && res.request().method() === "POST");
      if (i === 8) await shot(page, "03-word-check", size);
      await page.getByRole("radio", { name: i < 12 ? "I know it but don't use it" : "I use it", exact: true }).check();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      expect((await response).status()).toBe(200);
    }
    await expect(page.getByRole("heading", { name: "Your starting words are ready" })).toBeVisible();
    await expect(page.locator(".wl-chip")).toHaveCount(3);
    await page.locator(".wl-chip").last().evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
    await shot(page, "04-word-map", size);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("link", { name: "Add to Chrome" })).toHaveAttribute("href", /#browser-extension$/);
    await expect(page.getByRole("link", { name: "Download for Mac" })).toHaveAttribute("href", /#desktop-app$/);
    await shot(page, "05-tools", size);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your first practice is ready" })).toBeVisible();
    await expect.poll(() => page.locator(".morph-caption").evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
    await page.setViewportSize({ ...viewport, width: viewport.width - 1 });
    await expect(page.locator(".word-line")).toHaveClass(/is-morphed/);
    await page.setViewportSize(viewport);
    await shot(page, "06-all-set", size);
    const practice = createFixturePracticeClient("flow");
    await page.route("**/api/practice/sessions", async route => {
      const result = await practice.prepare({ requestId: crypto.randomUUID() });
      if (result.ok) await route.fulfill({ json: result.data });
    });
    await page.route("**/api/practice/sessions/*/next", async route => {
      const result = await practice.next("fixture");
      if (result.ok) await route.fulfill({ json: result.data });
    });
    await page.route("**/api/practice/sessions/*", async route => {
      if (route.request().url().endsWith("/next")) { await route.fallback(); return; }
      const result = await practice.readiness("fixture");
      if (result.ok) await route.fulfill({ json: result.data });
    });
    await page.getByRole("button", { name: "Start first practice" }).click();
    await expect(page).toHaveURL("/practice");
    await expect(page.getByRole("region", { name: "Practice session", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check answer", exact: true })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL("/practice");
    await page.goto("/onboarding");
    await expect(page).toHaveURL("/practice");
    expect(errors).toEqual([]);
  });
}

test("unsure uses B1, saved answers resume, and failures stay in place", async ({ page }) => {
  await joinAsNewLearner(page);
  await page.goto("/practice");
  await page.getByRole("button", { name: "Get started" }).click();
  await page.route("**/api/onboarding/level", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":"internal","message":"private provider stack"}}' }));
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".onb-error")).toHaveText("We couldn't save that. Please try again.");
  await expect(page.getByRole("heading", { name: "What's your English level?" })).toBeVisible();
  await page.unroute("**/api/onboarding/level");
  const chosen = page.waitForRequest(request => request.url().endsWith("/api/onboarding/level") && request.method() === "POST");
  await page.getByRole("button", { name: "Not sure? The word check will tell." }).click();
  expect((await chosen).postDataJSON()).toEqual({ level: "unsure" });
  await expect(page.getByRole("progressbar", { name: "Word check progress" })).toBeVisible();
  await page.keyboard.press("2");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  await page.reload();
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
});

test("reduced motion is static and turning it on stops a living line", async ({ page }) => {
  await joinAsNewLearner(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/practice");
  await expect(page.locator(".wl-dot")).toHaveCount(44);
  await expect(page.locator(".wl-arrow path")).toHaveCount(1);
  const position = await page.locator(".wl-dot").first().getAttribute("style");
  await page.waitForTimeout(200);
  expect(await page.locator(".wl-dot").first().getAttribute("style")).toBe(position);
  expect(await page.locator(".word-line").evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator(".wl-words")).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".wl-arrow path")).toHaveCount(1);
  expect(await page.locator(".word-line").evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
  await page.evaluate(async () => {
    const round = await (await fetch("/api/onboarding/word-check")).json();
    const response = await fetch("/api/onboarding/word-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: round.entries.map((entry: { id: string }) => ({ id: entry.id, answer: "know_unused" })) }) });
    if (!response.ok) throw new Error("Could not prepare the saved round");
  });
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your starting words are ready" })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".word-line")).toHaveClass(/is-morphed/);
  await expect(page.locator(".morph-bar i")).toHaveCount(8);
  expect(await page.locator(".word-line").evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
});

test("the living line drifts, reveals a hovered word and crosses into active use", async ({ page }) => {
  await joinAsNewLearner(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/practice");
  const dot = page.locator(".wl-dot.is-passive").first();
  await expect(dot).toBeVisible();
  const position = await dot.getAttribute("style");
  await expect.poll(() => dot.getAttribute("style")).not.toBe(position);
  await dot.hover({ force: true });
  await expect(page.locator(".wl-word").filter({ hasText: /^meticulous$/ })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.locator(".wl-trail")).toHaveCount(1);
  await expect(page.locator(".wl-dot.is-active")).toHaveCount(11);
  await expect(page.locator(".wl-dot.is-active")).toHaveCount(10);
  await expect(page.locator(".wl-dot.is-passive")).toHaveCount(34);
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.locator(".wl-words")).toHaveCount(0);
});
