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
    expect(PROOFREAD_PROMPT_VERSION, updateMessage).toBe("proofread-v9");
    expect(promptHash("check"), updateMessage).toBe("6c71c2023535b3affdbd8fb3b633859a3f99c5e6c37fcb869a2978331554658b");
    expect(promptHash("verify"), updateMessage).toBe("0891d84ee5a74cd9a20f72a7cf232fe4da310a5a865bf8bdf88887677c88edba");
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
