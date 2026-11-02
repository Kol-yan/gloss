// Sample history for the dev-only gallery. Not real learner data.
import type { ExpressionHistory } from "@/shared/contracts";

export const SAMPLE_HISTORY: ExpressionHistory[] = [
  {
    expression: { id: "push-back", text: "push back", meaning: "To move something to a later time.", familiarity: "new" },
    nextPracticeLabel: "Today",
    due: true,
    entries: [
      { kind: "spoken_attempt", verdict: "almost", cue: "hidden", hintUsed: true, transcriptEdited: true, dayLabel: "Today" },
      { kind: "written_attempt", verdict: "used_well", cue: "shown", hintUsed: false, transcriptEdited: false, dayLabel: "Yesterday" },
      { kind: "assisted_use", verdict: null, cue: null, hintUsed: false, transcriptEdited: false, dayLabel: "3 Nov" },
    ],
  },
  {
    expression: { id: "look-into", text: "look into", meaning: "To check the facts about something.", familiarity: "known_unused" },
    nextPracticeLabel: "In 4 days",
    due: false,
    entries: [
      { kind: "written_attempt", verdict: "not_yet", cue: "shown", hintUsed: false, transcriptEdited: false, dayLabel: "2 days ago" },
      { kind: "assisted_use", verdict: null, cue: null, hintUsed: false, transcriptEdited: false, dayLabel: "30 Oct" },
    ],
  },
  {
    expression: { id: "in-the-loop", text: "keep someone in the loop", meaning: "To keep telling someone what is happening.", familiarity: "new" },
    nextPracticeLabel: null,
    due: false,
    entries: [{ kind: "assisted_use", verdict: null, cue: null, hintUsed: false, transcriptEdited: false, dayLabel: "Today" }],
  },
];
