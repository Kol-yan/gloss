import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EVALUATION_PROMPT_VERSION, EVALUATION_SYSTEM_PROMPT } from "@/server/practice/evaluation";

const updateMessage = "Prompt changed: bump EVALUATION_PROMPT_VERSION, run the corpus once, commit the result, then update these values.";

describe("evaluation prompt version", () => {
  it("pins the version and the prompt hash", () => {
    const hash = createHash("sha256").update(EVALUATION_SYSTEM_PROMPT).digest("hex");
    expect(EVALUATION_PROMPT_VERSION, updateMessage).toBe("evaluation-v4");
    expect(hash, updateMessage).toBe("9729486af1bcaab9a2b2594fe94214b1d81a9dd15c4b65c267c10476fa6ef860");
  });

  it("has a full result for the pinned prompt version", async () => {
    let files: string[] = [];
    try {
      files = await readdir(new URL("../../eval/results/", import.meta.url));
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const expected = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${EVALUATION_PROMPT_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.md$`);
    expect(
      files.some((file) => expected.test(file)),
      "Run the corpus once, commit the result, then update the pinned values.",
    ).toBe(true);
  });
});
