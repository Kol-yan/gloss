// The starter set used by Word check, new-word intake and practice.
//
// Bands are curated by hand for each entry, not imported from a frequency
// list; ARCHITECTURE.md, "Starter set and frequency bands", explains why and
// how a band is assigned. Keep batches at 100 entries so the spread can be
// reviewed batch by batch.

import type { StarterEntry } from "./entries";
import { BATCH_A_EXPRESSIONS } from "./batches/batch-a-expressions";
import { BATCH_B_EXPRESSIONS } from "./batches/batch-b-expressions";
import { BATCH_C_WORDS } from "./batches/batch-c-words";
import { BATCH_D_WORDS } from "./batches/batch-d-words";

export const STARTER_ENTRIES: readonly StarterEntry[] = [
  ...BATCH_A_EXPRESSIONS,
  ...BATCH_B_EXPRESSIONS,
  ...BATCH_C_WORDS,
  ...BATCH_D_WORDS,
];
