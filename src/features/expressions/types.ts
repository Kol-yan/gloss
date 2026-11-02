import type { Verdict } from "@/features/practice/types";

// One line in an expression's history. Labels are plain words, never scores.
export type HistoryEntry = {
  id: string;
  kind: "assisted" | "written" | "spoken";
  // Present for attempts only. "unavailable" attempts are not stored.
  verdict?: Exclude<Verdict, "unavailable">;
  // Already formatted for display, e.g. "Today" or "3 days ago".
  whenLabel: string;
};

export type ExpressionHistory = {
  id: string;
  expression: string;
  meaning: string;
  // Newest first.
  entries: HistoryEntry[];
  // Already formatted, e.g. "tomorrow". Null when nothing is scheduled.
  nextPracticeLabel: string | null;
};
