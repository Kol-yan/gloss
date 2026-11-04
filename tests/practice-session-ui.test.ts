import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PracticeSession } from "@/components/practice-session";
import {
  createFixturePracticeClient,
  practiceFixtureExercises,
  type PracticeFixtureName,
} from "@/lib/practice-session-fixtures";

afterEach(() => vi.unstubAllGlobals());

function renderFixture(name: PracticeFixtureName): string {
  return renderToStaticMarkup(createElement(PracticeSession, {
    client: createFixturePracticeClient(name),
    initialFixture: name,
  }));
}

describe("practice session UI", () => {
  it("renders each multiple-choice rung with four options and accessible progress", () => {
    const rungs = [
      { name: "recognise", index: 0, label: "Recognise in context" },
      { name: "meaning", index: 1, label: "Choose by meaning" },
      { name: "gap", index: 2, label: "Fill the gap" },
    ] as const;

    for (const rung of rungs) {
      const html = renderFixture(rung.name);
      const exercise = practiceFixtureExercises[rung.index];

      expect(html).toContain(rung.label);
      expect(html).toContain('role="progressbar"');
      expect(html).toMatch(/aria-valuenow="\d+"/);
      expect(html).toMatch(/aria-valuemax="8"/);
      expect(exercise.options).toHaveLength(4);
      expect(html.match(/type="radio"/g) ?? []).toHaveLength(4);
      for (const option of exercise.options ?? []) expect(html).toContain(option);
    }
  });

  it("uses typed recall on rung four instead of answer options", () => {
    const html = renderFixture("recall");

    expect(html).toContain("Recall from memory");
    expect(html).toMatch(/<input\b/);
    expect(html).toContain("Your answer");
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("A point that slows progress");
    expect(html).not.toContain("A subtle difference");
  });

  it("separates correct and incorrect answer states with green and warm classes", () => {
    const correct = renderFixture("correct");
    const wrong = renderFixture("wrong");

    expect(correct).toMatch(/class="[^"]*(?:green|correct|success)[^"]*"/i);
    expect(wrong).toMatch(/class="[^"]*(?:warm|wrong|incorrect|error)[^"]*"/i);
  });

  it("exposes hint and reaction controls with useful tooltips", () => {
    const exercise = renderFixture("recognise");
    const answer = renderFixture("correct");

    expect(exercise).toContain('>Hint</button>');
    expect(exercise).toContain('title="A small clue is recorded with this answer."');
    expect(answer).toMatch(/(?:title|aria-label)="[^"]*already know[^"]*"/i);
    expect(answer).toMatch(/(?:title|aria-label)="[^"]*too easy[^"]*"/i);
    expect(answer).toMatch(/(?:title|aria-label)="[^"]*not relevant[^"]*"/i);
    expect(answer).toMatch(/(?:title|aria-label)="[^"]*too hard[^"]*"/i);
  });

  it("keeps the active-use path and word history inline with the answer", () => {
    const html = renderFixture("correct");

    expect(html).toContain('aria-label="Conceptual path from knowing a word to using it"');
    expect(html).toContain('title="A learning path, not your stored word status."');
    expect(html.match(/class="[^"]*path-dot[^"]*"/g) ?? []).toHaveLength(3);
    expect(html).toContain('aria-label="Word history, this session only"');
    expect(html).toContain("This session · correct");
    expect(html).toMatch(/Earlier history isn(?:&#x27;|')t available here\./);
  });

  it("keeps preparing and waiting screens compact", () => {
    const boot = renderFixture("flow");
    const preparing = renderFixture("preparing");
    const waiting = renderFixture("waiting");

    expect(boot).toMatch(/role="status"|aria-live="polite"/);
    expect(boot).not.toContain("bottleneck");
    expect(preparing).toMatch(/role="status"|aria-live="polite"/);
    expect(preparing).not.toContain("bottleneck");
    expect(preparing).not.toContain("steady");
    expect(preparing).not.toContain("concise");
    expect(waiting).toMatch(/role="status"|aria-live="polite"/);
    expect(waiting).not.toContain("bottleneck");
    expect(waiting).not.toContain("steady");
  });

  it("shows the short eight-word end summary and two actions", () => {
    const html = renderFixture("end");

    expect(html).toContain("8 words in 6 minutes.");
    expect(html.match(/<(?:button|a)\b/g) ?? []).toHaveLength(2);
  });

  it("does not render raw provider errors or stack details", () => {
    const html = renderFixture("error");

    expect(html).not.toContain("provider stack trace");
    expect(html).not.toContain("private upstream detail");
    expect(html).not.toContain("Practice could not be prepared.");
  });

  it("keeps every fixed-state fixture local without calling fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const names: PracticeFixtureName[] = [
      "preparing", "recognise", "meaning", "gap", "recall", "correct", "wrong", "end", "waiting", "error",
    ];

    for (const name of names) expect(renderFixture(name)).not.toBe("");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
