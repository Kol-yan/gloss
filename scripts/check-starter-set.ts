// Confirms the starter set is compiled into the server bundle, not left as a
// runtime file that the standalone image might not carry. Run with
// `npx tsx scripts/check-starter-set.ts`; also used by the test suite.
import { starterSet } from "../src/server/learning/starter";
import { CEFR_LEVELS, FREQUENCY_BANDS } from "../src/server/learning/starter/entries";

const { stats } = starterSet();
console.log(
  `starter set: ${stats.total} entries (${stats.words} words, ${stats.expressions} expressions)`,
);
console.log(`bands: ${FREQUENCY_BANDS.map((band) => `${band} ${stats.byBand[band]}`).join(", ")}`);
console.log(`levels: ${CEFR_LEVELS.map((level) => `${level} ${stats.byLevel[level]}`).join(", ")}`);
