import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VocabularyPronunciation } from "@/components/vocabulary-pronunciation";
import { FeedbackPanel } from "@/features/practice/feedback-panel";
import { SAMPLE_EVALUATIONS, SAMPLE_WRITTEN_TASK } from "@/features/practice/fixtures";
import { TaskCard } from "@/features/practice/practice-shell";

const WORD = "resilient";
const IPA = "/rɪˈzɪliənt/";

describe("vocabulary pronunciation surfaces", () => {
  it("shows IPA and an explicit accessible button for a single word", () => {
    const html = renderToStaticMarkup(createElement(VocabularyPronunciation, { text: WORD, ipa: IPA }));
    expect(html).toContain(IPA);
    expect(html).toContain(`Pronounce ${WORD}`);
    expect(html).toContain('type="button"');
    expect(html).toContain("Loading voice");
    expect(html).toContain('disabled=""');
  });

  it("suppresses pronunciation controls and IPA for phrases", () => {
    expect(renderToStaticMarkup(createElement(VocabularyPronunciation, { text: "push back", ipa: IPA }))).toBe("");
    expect(renderToStaticMarkup(createElement(VocabularyPronunciation, { text: "", ipa: IPA }))).toBe("");
  });

  it("does not invent IPA when it is missing or invalid", () => {
    const missing = renderToStaticMarkup(createElement(VocabularyPronunciation, { text: WORD }));
    expect(missing).toContain(`Pronounce ${WORD}`);
    expect(missing).toContain("IPA unavailable");
    expect(missing).not.toContain("IPA:");
    const invalid = renderToStaticMarkup(createElement(VocabularyPronunciation, { text: WORD, ipa: "A pronunciation explanation" }));
    expect(invalid).not.toContain("A pronunciation explanation");
    expect(invalid).not.toContain("IPA:");
  });

  it("never exposes a hidden task's word or IPA, even if the payload includes them", () => {
    const task = { ...SAMPLE_WRITTEN_TASK, expression: WORD, ipa: IPA, cue: "hidden" as const };
    const hidden = renderToStaticMarkup(createElement(TaskCard, { task, label: "Writing" }));
    expect(hidden).not.toContain(WORD);
    expect(hidden).not.toContain(IPA);
    expect(hidden).not.toContain("Pronounce");
    const shown = renderToStaticMarkup(createElement(TaskCard, { task: { ...task, cue: "shown" }, label: "Writing" }));
    expect(shown).toContain(WORD);
    expect(shown).toContain(IPA);
  });

  it("reveals hidden pronunciation only after a real evaluated verdict", () => {
    const feedback = { ...SAMPLE_EVALUATIONS.used_well, target: WORD, ipa: IPA, message: "Well done." };
    const actual = renderToStaticMarkup(createElement(FeedbackPanel, { feedback, answer: "An answer.", revealTarget: true }));
    expect(actual).toContain(WORD);
    expect(actual).toContain(IPA);
    const unavailable = renderToStaticMarkup(createElement(FeedbackPanel, {
      feedback: { ...feedback, verdict: "unavailable", message: "We could not check your answer.", correction: WORD },
      answer: "An answer.", revealTarget: true,
    }));
    expect(unavailable).not.toContain(WORD);
    expect(unavailable).not.toContain(IPA);
    expect(unavailable).not.toContain("Pronounce");
  });
});
