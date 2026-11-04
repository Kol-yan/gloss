import { expect, saveExpression, test } from "./fixtures";

test("a learner with no due words gets an empty practice session", async ({ editor, page }) => {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Practice" }).click();
  await expect(page).toHaveURL("/practice");
  // The session engine starts with the words the onboarding word check left
  // here; none of them is due yet, so the round is empty.
  await expect(page.getByRole("region", { name: "Practice session" })).toContainText(/\d+ words in \d+ minutes\./);
  await expect(page.getByText("0 words in 0 minutes.")).toBeVisible();

  await page.getByRole("link", { name: "Back to writing" }).click();
  await expect(editor.text).toBeVisible();
});

test("practises a saved expression and gets feedback", async ({ editor, page }) => {
  await saveExpression(editor);

  // The session starts at the rung the stored familiarity earns: choosing the
  // expression that matches the meaning.
  const session = page.getByRole("region", { name: "Practice session" });
  await expect(session).toContainText("Choose by meaning");
  await expect(session).toContainText("to find a solution to a problem");
  await page.getByRole("radio", { name: "resolve" }).check();
  await page.getByRole("button", { name: "Check answer" }).click();

  await expect(session).toContainText("Correct");
  await expect(session).toContainText("to find a solution to a problem");
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
});
