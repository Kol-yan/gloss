import { normalizeText } from "@/lib/text";
import { MAX_TEXT_LENGTH } from "@/shared/contracts";

export type CapturedSelection =
  | { status: "accepted"; text: string }
  | { status: "too-long" | "empty"; text: "" };

// Fragments are not sent in HTTP requests. Treat their contents as untrusted
// plain text, just like a paste into the editor; never as markup or a command.
export function parseSelectionFragment(fragment: string): CapturedSelection | null {
  if (fragment.length > MAX_TEXT_LENGTH * 12 + 256) return { status: "too-long", text: "" };
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  if (params.get("capture") === "too-long") return { status: "too-long", text: "" };
  if (!params.has("text")) return null;
  const text = normalizeText(params.get("text") ?? "");
  if (text.length > MAX_TEXT_LENGTH) return { status: "too-long", text: "" };
  if (!text.trim()) return { status: "empty", text: "" };
  return { status: "accepted", text };
}

export const SELECTION_NOTICE = {
  accepted: "Selected text is ready. Review it before checking.",
  "too-long": "The selection is longer than 6,000 characters. Choose a shorter passage.",
  empty: "The selection is empty. Select some English text and try again.",
} as const;
