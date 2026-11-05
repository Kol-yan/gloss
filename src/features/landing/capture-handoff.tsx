"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { parseSelectionFragment } from "@/features/capture/selection";

// Existing installed tools may still open capture links at the site root.
// Keep selected text in a fragment until the editor consumes and clears it.
export function captureEditorHref(fragment: string): string | null {
  const selection = parseSelectionFragment(fragment);
  if (!selection) return null;
  if (selection.status === "too-long") return "/editor#capture=too-long";
  return `/editor#${new URLSearchParams({ text: selection.text })}`;
}

export function CaptureHandoff() {
  const router = useRouter();
  useEffect(() => {
    const handoff = () => {
      const href = captureEditorHref(window.location.hash);
      if (href) router.replace(href);
    };
    handoff();
    window.addEventListener("hashchange", handoff);
    return () => window.removeEventListener("hashchange", handoff);
  }, [router]);
  return null;
}
