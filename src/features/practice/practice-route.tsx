"use client";

import { useSearchParams } from "next/navigation";
import { PracticePicker } from "./practice-picker";
import { PracticeSession } from "./practice-session";

// Chooses between a running session (?expression=ID) and the list of what is due.
export function PracticeRoute() {
  const expressionId = useSearchParams().get("expression");
  // Keyed so that opening another expression starts a fresh session.
  return expressionId ? <PracticeSession key={expressionId} expressionId={expressionId} /> : <PracticePicker />;
}
