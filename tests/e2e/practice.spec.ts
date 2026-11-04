import { MOCK_SITUATION } from "@/server/models/mock-provider";
import { expect, saveExpression, test } from "./fixtures";

test("a learner with no practice words is sent to the editor", async ({ editor, page }) => {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Practice" }).click();
  await expect(page).toHaveURL("/practice");
  await expect(page.getByRole("heading", { name: "Nothing to practice yet" })).toBeVisible();

  await page.getByRole("link", { name: "Open the editor" }).click();
  await expect(editor.text).toBeVisible();
});

test("practises a saved expression in writing and gets feedback", async ({ editor, page }) => {
  await saveExpression(editor);

  const task = page.getByRole("region", { name: "Task" });
  await expect(task).toContainText("Use this expression");
  await expect(task).toContainText("resolve");
  await expect(task).toContainText(MOCK_SITUATION);

  await page.getByRole("textbox", { name: "Your answer" }).fill("I would resolve the delay by moving one task to next week.");
  await page.getByRole("button", { name: "Submit" }).click();

  const feedback = page.getByRole("region", { name: "Feedback" });
  await expect(feedback).toContainText("Used well");
  await expect(feedback).toContainText("Nice work: “resolve” fits your answer naturally.");
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
});
