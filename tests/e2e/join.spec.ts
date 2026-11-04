import { expect, test } from "@playwright/test";
import { inviteUrl } from "./env";
import { joinAsNewLearner } from "./fixtures";

test("joins through an invite link and lands in the editor", async ({ page, context }) => {
  // Without a session there is no editor, only the ways in.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose how to try gloss" })).toBeVisible();

  await joinAsNewLearner(page);
  const session = (await context.cookies()).find((cookie) => cookie.name === "glossy_session");
  expect(session?.httpOnly).toBe(true);

  // Opening the link again in a signed-in browser does not spend another use.
  await page.goto(inviteUrl());
  await expect(page.getByRole("heading", { name: "You are already signed in" })).toBeVisible();
  await page.getByRole("link", { name: "Back to the editor" }).click();
  await expect(page.getByRole("textbox", { name: "Your text" })).toBeVisible();
});

test("an unknown invite link says it did not work", async ({ page }) => {
  // Well formed, but never issued.
  await page.goto(`/join/${"A".repeat(43)}`);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL("/?invite=invalid");
  await expect(page.getByText("That invite link didn't work.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose how to try gloss" })).toBeVisible();
});
