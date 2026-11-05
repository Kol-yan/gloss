import { expect, test } from "@playwright/test";
import { inviteUrl } from "./env";

test("an invite link starts a workspace and a second visit only raises its allowance", async ({ page, context }) => {
  // The site root is the landing page; the editor lives at /editor and works on its own.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Write it right. Then make the words your own." })).toBeVisible();
  await page.goto("/editor");
  await expect(page.getByRole("textbox", { name: "Your text" })).toBeEditable();

  await page.goto(inviteUrl());
  await expect(page.getByRole("heading", { name: "You are invited to gloss" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL("/editor");
  await expect(page.getByText(/\d+ checks? left today/)).toBeVisible();

  // The production server uses the plain cookie name; only development adds a port.
  const session = (await context.cookies()).find((cookie) => cookie.name === "glossy_session");
  expect(session?.httpOnly).toBe(true);

  // Opening the link again in a signed-in browser does not spend another use.
  await page.goto(inviteUrl());
  await expect(page.getByRole("heading", { name: "Add this invite to your workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("textbox", { name: "Your text" })).toBeVisible();
});

test("an unknown invite link returns to the editor without a gate", async ({ page }) => {
  // Well formed, but never issued.
  await page.goto(`/join/${"A".repeat(43)}`);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL("/editor?invite=invalid");
  await expect(page.getByRole("textbox", { name: "Your text" })).toBeEditable();
});
