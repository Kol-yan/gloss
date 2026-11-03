import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PROOFREAD_PROMPT_VERSION, proofreadSystemPrompt } from "@/server/proofread/prompt";

const updateMessage = "Prompt changed: bump PROOFREAD_PROMPT_VERSION, run the corpus once, commit the result, then update these hashes.";

function promptHash(mode: "check" | "verify"): string {
  return createHash("sha256").update(proofreadSystemPrompt(mode)).digest("hex");
}

describe("proofread prompt version", () => {
  it("pins the version and both prompt hashes", () => {
    expect(PROOFREAD_PROMPT_VERSION, updateMessage).toBe("proofread-v6");
    expect(promptHash("check"), updateMessage).toBe("51ba2dd4c1e69161fee53be75ff52fdf91f27140c0a7c86b479d900a8c411657");
    expect(promptHash("verify"), updateMessage).toBe("a85b7bc15987459d02dc73446d3d1503a2b2934a874c956500e1225fdc5ba4d8");
  });

  it("has a result for the pinned prompt version", async () => {
    let files: string[] = [];
    try {
      files = await readdir(new URL("../../eval/results/", import.meta.url));
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const expected = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${PROOFREAD_PROMPT_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.md$`);
    expect(
      files.some((file) => expected.test(file)),
      "Run the corpus once, commit the result, then update these hashes.",
    ).toBe(true);
  });
});
