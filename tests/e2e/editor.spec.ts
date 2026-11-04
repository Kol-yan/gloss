import { expect, SAMPLE_TEXT, test } from "./fixtures";

test("flags a sentence after a typing pause and shows its suggestion", async ({ editor }) => {
  await editor.write(SAMPLE_TEXT);

  // Stage 1: the detector flags the misspelled sentence on its own.
  const flag = editor.flagCard("recieve");
  const badge = flag.getByRole("button", { name: "Correction: review this sentence" });
  await expect(badge).toBeVisible();

  // Stage 2: pressing the badge asks for the corrected sentence.
  await badge.click();
  const card = editor.aiCard("recieve");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Error");
  await expect(card).toContainText("“Receive” is spelled with “ei” after “c”.");
  await expect(flag).toHaveCount(0);
});

test("applies one suggestion and dismisses another", async ({ editor }) => {
  await editor.write(SAMPLE_TEXT);
  // Let the automatic scan finish first, so its badges cannot arrive after the check.
  await expect(editor.flagCard("recieve")).toBeVisible();
  await expect(editor.flagCard("fix")).toBeVisible();

  await editor.checkButton.click();
  const fix = editor.aiCard("recieve");
  const expression = editor.aiCard("fix");
  await expect(fix).toBeVisible();
  await expect(expression).toContainText("Expression");

  await fix.getByRole("button", { name: /^Apply: / }).click();
  await expect(editor.text).toHaveValue("I will receive the report tomorrow. We need to fix the problem soon.");
  await expect(fix).toHaveCount(0);
  await expect(editor.rail.getByText("Applied: receive")).toBeVisible();

  await expression.getByRole("button", { name: /^Dismiss: / }).click();
  await expect(expression).toHaveCount(0);
  await expect(editor.rail.getByText("Dismissed.")).toBeVisible();
  await expect(editor.text).toHaveValue("I will receive the report tomorrow. We need to fix the problem soon.");
  // Nothing is offered for practice from a dismissed expression.
  await expect(editor.rail.getByRole("region", { name: "Try using this yourself" })).toHaveCount(0);
});
