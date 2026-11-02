// Sample history for the dev-only gallery. Not real learner data.
import type { ExpressionHistory } from "./types";

export const SAMPLE_HISTORY: ExpressionHistory[] = [
  {
    id: "push-back",
    expression: "push back",
    meaning: "To move something to a later time.",
    nextPracticeLabel: "tomorrow",
    entries: [
      { id: "1", kind: "spoken", verdict: "almost", whenLabel: "Today" },
      { id: "2", kind: "written", verdict: "used_well", whenLabel: "Yesterday" },
      { id: "3", kind: "assisted", whenLabel: "3 days ago" },
    ],
  },
  {
    id: "look-into",
    expression: "look into",
    meaning: "To check the facts about something.",
    nextPracticeLabel: "in 4 days",
    entries: [
      { id: "4", kind: "written", verdict: "not_yet", whenLabel: "2 days ago" },
      { id: "5", kind: "assisted", whenLabel: "5 days ago" },
    ],
  },
  {
    id: "keep-in-the-loop",
    expression: "keep someone in the loop",
    meaning: "To keep telling someone what is happening.",
    nextPracticeLabel: null,
    entries: [{ id: "6", kind: "assisted", whenLabel: "Today" }],
  },
];
