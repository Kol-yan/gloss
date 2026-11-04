import { MOCK_FAILURE_MARKERS, MOCK_RAW_ERROR_DETAIL, type MockFailure } from "@/server/models/mock-provider";
import { expect, expectNoRawErrorText, saveExpression, test } from "./fixtures";

const FAILURES: { kind: MockFailure; what: string }[] = [
  { kind: "http", what: "answers with an error status and a raw body" },
  { kind: "network", what: "drops the connection" },
  { kind: "output", what: "answers with something that is not a model answer" },
];

for (const { kind, what } of FAILURES) {
  test(`a check whose provider ${what} shows only a short message`, async ({ editor, page }) => {
    // The marker makes the simulated provider fail for this text.
    const text = `Please look at this sentence ${MOCK_FAILURE_MARKERS[kind]} before lunch.`;
    const scan = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/detect");
    await editor.write(text);

    // The automatic scan fails first. The learner did not ask for it, so the editor stays quiet.
    expect((await scan).status()).toBeGreaterThanOrEqual(500);
    await expect(editor.rail.locator("li[data-flag-card]")).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: "couldn't" })).toHaveCount(0);
    await expectNoRawErrorText(page);

    const answer = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/proofread");
    await editor.checkButton.click();
    const response = await answer;
    expect(response.status()).toBeGreaterThanOrEqual(500);
    const body = await response.text();
    expect(body).not.toContain(MOCK_RAW_ERROR_DETAIL);
    expect(JSON.parse(body)).toEqual({
      error: { code: "model_unavailable", message: "The cloud checker is not available right now. Please try again." },
    });

    await expect(
      page.getByRole("alert").filter({ hasText: "We couldn't check your text just now. Your text is safe. Try again." }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
    await expect(editor.text).toHaveValue(text);
    await expect(editor.rail.locator("li[data-suggestion-id]").filter({ hasText: "AI check" })).toHaveCount(0);
    await expectNoRawErrorText(page);
  });
}

test("a practice answer whose check fails is not counted and shows no provider detail", async ({ editor, page }) => {
  await saveExpression(editor);
  await expect(page.getByRole("region", { name: "Task" })).toBeVisible();

  await page.getByRole("textbox", { name: "Your answer" }).fill(`I would resolve it ${MOCK_FAILURE_MARKERS.http} today.`);
  await page.getByRole("button", { name: "Submit" }).click();

  const feedback = page.getByRole("region", { name: "Feedback" });
  await expect(feedback).toContainText("Couldn't check");
  await expect(feedback).toContainText("We could not check this answer just now. It is saved, so you can try again.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expectNoRawErrorText(page);
});
