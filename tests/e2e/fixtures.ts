import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { MOCK_RAW_ERROR_DETAIL } from "@/server/models/mock-provider";
import { inviteUrl } from "./env";

// Sentence 1 has a spelling mistake the simulated proofreader corrects; sentence 2
// has a word it offers a more precise expression for (see models/mock-provider.ts).
export const SAMPLE_TEXT = "I will recieve the report tomorrow. We need to fix the problem soon.";

// Redeems the shared invite link, so every test works as a learner of its own:
// no suggestions, quotas or saved expressions carry over between tests.
export async function joinAsNewLearner(page: Page): Promise<void> {
  await page.goto(inviteUrl());
  await expect(page.getByRole("heading", { name: "You are invited to gloss" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("textbox", { name: "Your text" })).toBeEditable();
  // The quota line appears once the session is known on the page.
  await expect(page.getByText(/\d+ checks? left today/)).toBeVisible();
}

// Editor and expression tests start after onboarding; onboarding itself has a
// separate browser suite that follows every learner-facing step.
async function finishOnboardingSetup(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const roundResponse = await fetch("/api/onboarding/word-check");
    if (!roundResponse.ok) throw new Error("Could not prepare onboarding");
    const round = await roundResponse.json();
    const answersResponse = await fetch("/api/onboarding/word-check", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: round.entries.map((entry: { id: string }) => ({ id: entry.id, answer: "use" })) }),
    });
    if (!answersResponse.ok) throw new Error("Could not answer onboarding");
    const completeResponse = await fetch("/api/onboarding/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!completeResponse.ok) throw new Error("Could not complete onboarding");
  });
}

export class Editor {
  readonly text: Locator;
  readonly rail: Locator;
  readonly checkButton: Locator;

  constructor(readonly page: Page) {
    this.text = page.getByRole("textbox", { name: "Your text" });
    this.rail = page.getByRole("complementary", { name: "Suggestions" });
    this.checkButton = page.getByRole("button", { name: "Check with AI" });
  }

  async write(text: string): Promise<void> {
    await this.text.fill(text);
  }

  // Switching tabs asks the simulator for the sentence analysis, so cards for
  // the flagged sentences appear without pressing Check with AI.
  async openAiTab(): Promise<void> {
    await this.page.getByRole("tab", { name: /^AI/ }).click();
  }

  // A cloud suggestion card in the rail, found by the words it changes.
  aiCard(original: string): Locator {
    return this.rail
      .locator("li[data-suggestion-id]")
      .filter({ has: this.page.getByRole("button", { name: new RegExp(`^Apply: ${original} to `) }) });
  }
}

// Accepts the simulated "fix → resolve" expression, saves it, and opens the
// practice session the new engine prepares for it.
export async function saveExpression(editor: Editor): Promise<void> {
  await editor.write(SAMPLE_TEXT);
  // The AI tab starts the analysis of the sentences the detector flagged.
  await editor.openAiTab();
  const expression = editor.aiCard("fix");
  await expect(expression).toBeVisible();
  await expression.getByRole("button", { name: /^Apply: / }).click();

  // Accepting an expression offers the practice question in the Learning tab.
  await editor.page.getByRole("tab", { name: /^Learning/ }).click();
  const offer = editor.rail.getByRole("region", { name: "Try using this yourself" });
  await expect(offer).toContainText("resolve");
  await expect(offer).toContainText("to find a solution to a problem");
  await offer.getByText("I know it but don't use it").click();
  // The editor only saves the expression; practice starts from the practice page.
  await offer.getByRole("button", { name: "Save expression" }).click();
  await expect(editor.rail.getByRole("region", { name: "Practice ready" })).toBeVisible();

  await editor.page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Practice" }).click();
  await expect(editor.page).toHaveURL("/practice");
  await expect(editor.page.getByRole("region", { name: "Practice session" })).toBeVisible();
  await expect(editor.page.getByRole("button", { name: "Check answer" })).toBeVisible();
}

// What a provider might send back when it breaks. None of it may reach the page.
const RAW_ERROR_PATTERNS: RegExp[] = [
  new RegExp(escapeRegExp(MOCK_RAW_ERROR_DETAIL)),
  /traceback/i,
  /internal server error/i,
  /\bHTTP \d{3}\b/,
  /\b\w+Error\b/,
  /provider answered/i,
  /fetch failed/i,
  /model_unavailable|invalid_output|envelope_not_json/,
  /\bat \S+ \(/,
  /<\/?(?:html|body)\b/i,
  /\{\s*"error"/,
];

export async function expectNoRawErrorText(page: Page): Promise<void> {
  const visible = await page.locator("body").innerText();
  for (const pattern of RAW_ERROR_PATTERNS) expect(visible).not.toMatch(pattern);
  // Not hidden in the markup either.
  const markup = await page.content();
  expect(markup).not.toContain(MOCK_RAW_ERROR_DETAIL);
  expect(markup).not.toMatch(/traceback/i);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const test = base.extend<{ editor: Editor }>({
  editor: async ({ page }, provide) => {
    await joinAsNewLearner(page);
    await finishOnboardingSetup(page);
    await provide(new Editor(page));
  },
});

export { expect };
