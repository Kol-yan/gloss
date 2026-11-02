import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FeedbackPanel } from "@/features/practice/feedback-panel";
import { SAMPLE_EVALUATIONS } from "@/features/practice/fixtures";
import { retryAttemptFor } from "@/features/practice/types";

describe("practice feedback", () => {
  it("rechecks the same attempt after an unavailable verdict even if a different retry id arrives", () => {
    const failed = { ...SAMPLE_EVALUATIONS.unavailable, attemptId: "original", retryAttemptId: "different" };
    expect(retryAttemptFor(failed)).toBe("original");
    expect(retryAttemptFor({ ...SAMPLE_EVALUATIONS.not_yet, retryAttemptId: "new-try" })).toBe("new-try");
    expect(retryAttemptFor(SAMPLE_EVALUATIONS.used_well)).toBeNull();
  });

  it("reveals the target after a hidden-cue answer is evaluated", () => {
    const feedback = { ...SAMPLE_EVALUATIONS.used_well, message: "Well done.", target: "take the lead" };
    const hidden = renderToStaticMarkup(createElement(FeedbackPanel, { feedback, answer: "I can help.", revealTarget: true }));
    expect(hidden).toContain("Expression to practice");
    expect(hidden).toContain("take the lead");
    const shown = renderToStaticMarkup(createElement(FeedbackPanel, { feedback, answer: "I can help." }));
    expect(shown).not.toContain("Expression to practice");
    expect(shown).not.toContain("take the lead");
  });
});
