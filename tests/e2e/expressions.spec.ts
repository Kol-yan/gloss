import { expect, saveExpression, test } from "./fixtures";

test("saves an expression from a suggestion and lists it", async ({ editor, page }) => {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "My expressions" }).click();
  await expect(page.getByRole("heading", { name: "No expressions yet" })).toBeVisible();
  await page.getByRole("link", { name: "Open the editor" }).click();

  await saveExpression(editor);
  // Wait for the first exercise, so leaving the page does not cut its preparation short.
  await expect(page.getByRole("button", { name: "Check answer" })).toBeVisible();

  // The practice session has no site navigation, so go back to the list directly.
  await page.goto("/expressions");
  await expect(page.getByRole("heading", { name: "My expressions", level: 1 })).toBeVisible();
  const item = page.getByRole("region", { name: "resolve" });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("to find a solution to a problem");
  // Accepting a suggestion is help, not knowledge, and is recorded as such.
  await expect(item).toContainText("Used with help");
});
