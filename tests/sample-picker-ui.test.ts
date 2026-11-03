import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { normalizeText } from "@/lib/text";
import { SamplePicker } from "@/features/editor/sample-picker";
import { SAMPLE_TEXTS } from "@/features/editor/sample-texts";
import { MAX_TEXT_LENGTH } from "@/shared/contracts";

describe("sample texts", () => {
  it("offers three distinct, short, normalized English texts", () => {
    expect(SAMPLE_TEXTS).toHaveLength(3);
    expect(new Set(SAMPLE_TEXTS.map((sample) => sample.id)).size).toBe(3);
    for (const sample of SAMPLE_TEXTS) {
      expect(sample.title.trim()).not.toBe("");
      expect(sample.text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
      // Editor ranges are UTF-16 offsets into normalized text, so a sample must already be normalized.
      expect(normalizeText(sample.text)).toBe(sample.text);
      expect(sample.text).not.toMatch(/\p{Script=Cyrillic}/u);
    }
  });
});

describe("sample picker", () => {
  it("renders a closed secondary disclosure without the samples", () => {
    const html = renderToStaticMarkup(createElement(SamplePicker, { onSelect: () => {} }));
    expect(html).toContain("Try a sample</button>");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("aria-controls");
    for (const sample of SAMPLE_TEXTS) expect(html).not.toContain(sample.title);
  });
});
