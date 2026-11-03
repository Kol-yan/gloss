// Splits text into runs for the highlight backdrop. Each run knows which
// suggestions cover it, so overlapping suggestions still render as one
// continuous, non-nested sequence of spans.
import type { Suggestion, SuggestionCategory } from "@/shared/contracts";
import type { FlagCategory, SentenceFlag } from "./sentence-detect";

export type Segment = {
  text: string;
  // Category that decides the decoration; null for plain text.
  category: SuggestionCategory | null;
  ids: string[];
  active: boolean;
  // Sentence the detector flagged, drawn under the whole sentence; null elsewhere.
  flag: FlagCategory | null;
  flagId: string | null;
  flagActive: boolean;
};

// When ranges overlap, the most urgent category wins the decoration.
const PRIORITY: Record<SuggestionCategory, number> = { error: 3, expression: 2, style: 1 };

export function buildSegments(
  text: string,
  suggestions: Suggestion[],
  activeId: string | null,
  flags: SentenceFlag[] = [],
  activeFlagId: string | null = null,
): Segment[] {
  const usable = suggestions.filter((s) => s.end > s.start && s.start >= 0 && s.end <= text.length);
  const flagged = flags.filter((f) => f.end > f.start && f.start >= 0 && f.end <= text.length);
  const cuts = new Set<number>([0, text.length]);
  for (const s of usable) {
    cuts.add(s.start);
    cuts.add(s.end);
  }
  for (const f of flagged) {
    cuts.add(f.start);
    cuts.add(f.end);
  }
  const points = [...cuts].sort((a, b) => a - b);

  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    if (to <= from) continue;
    const covering = usable.filter((s) => s.start <= from && s.end >= to);
    const active = covering.find((s) => s.id === activeId);
    const lead = active ?? covering.reduce<Suggestion | null>(
      (best, s) => (best === null || PRIORITY[s.category] > PRIORITY[best.category] ? s : best),
      null,
    );
    // Sentences never overlap each other, so at most one flag covers a run.
    const flag = flagged.find((f) => f.start <= from && f.end >= to) ?? null;
    const next: Segment = {
      text: text.slice(from, to),
      category: lead ? lead.category : null,
      ids: covering.map((s) => s.id),
      active: Boolean(active),
      flag: flag ? flag.categories[0] : null,
      flagId: flag ? flag.id : null,
      flagActive: flag !== null && flag.id === activeFlagId,
    };
    const last = segments.at(-1);
    // Merge neighbours that look and behave the same to keep the DOM small.
    if (
      last &&
      last.category === next.category &&
      last.active === next.active &&
      last.flagId === next.flagId &&
      last.flagActive === next.flagActive &&
      last.ids.join() === next.ids.join()
    ) {
      last.text += next.text;
    } else {
      segments.push(next);
    }
  }
  return segments;
}
