import { expect, test } from "@playwright/test";
import { inviteUrl } from "./env";

test("an invite link starts a workspace and a second visit only raises its allowance", async ({ page, context }) => {
  // There is no gate screen any more: the editor is the first page, with local
  // checking available even before a session exists.
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Your text" })).toBeEditable();

  await page.goto(inviteUrl());
  await expect(page.getByRole("heading", { name: "You are invited to gloss" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL("/");
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
  await expect(page).toHaveURL("/?invite=invalid");
  await expect(page.getByRole("textbox", { name: "Your text" })).toBeEditable();
});
