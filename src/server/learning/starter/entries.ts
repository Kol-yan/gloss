// The curated starter set: the first vocabulary a learner meets in practice.
//
// These entries are written for gloss, not taken from a published word list.
// See ARCHITECTURE.md, "Starter set and frequency bands", for the licence
// decision and for how a band is chosen for each entry.
//
// Every entry is either a single word ("text" has no space) or a short common
// expression ("text" has at least one space). The level is the CEFR level at
// which a learner is expected to understand the entry, not to produce it.

export const CEFR_LEVELS = ["A2", "B1", "B2", "C1"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

export const FREQUENCY_BANDS = ["core", "common", "uncommon", "rare"] as const;
export type FrequencyBand = (typeof FREQUENCY_BANDS)[number];

// Light, stable topics used to order a session and to keep unrelated entries
// apart. They describe where the word is met, not a learner's interests.
export const STARTER_TAGS = [
  "work",
  "time",
  "people",
  "communication",
  "money",
  "travel",
  "study",
  "technology",
  "daily",
  "emotion",
] as const;
export type StarterTag = (typeof STARTER_TAGS)[number];

export interface StarterEntry {
  text: string;
  band: FrequencyBand;
  level: CefrLevel;
  definition: string;
  example: string;
  tags: StarterTag[];
}
