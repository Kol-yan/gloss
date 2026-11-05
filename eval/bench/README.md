# Model bench

Compare models per role on **quality, latency and cost** before switching one.
The bench runs a dataset for one role against one provider and model, and
writes a Markdown summary and a JSONL file with one record per item.

| Role | Dataset | What is scored |
|---|---|---|
| `proofread` | `data/proofread.jsonl`: 200 short emails, chats and notes (160 with typical non-native mistakes, 40 clean) | Edits against the expected minimal corrections: precision, recall, F1; clean texts that got an edit |
| `dictation` | `data/dictation.jsonl`: 51 messy spoken transcripts | Normalized edit distance to the expected clean text; word preservation; whether the app accepts the answer |
| `evaluation` | `data/evaluation.jsonl`: 66 learner answers for target expressions | Verdict accuracy, false passes, including wrong-meaning and prompt-injection answers |

## What it reuses from the app

Every call goes through the same code as production, so the bench measures
what the app would actually do with a model:

- the prompt builders, JSON schemas and role settings (`max_tokens`,
  temperature, reasoning effort) from `src/server/proofread`,
  `src/server/dictation` and `src/server/practice`;
- the price table and cost bound from `src/server/models/prices.ts`, and the
  hosted route from `src/server/models/access.ts`;
- a real budget reservation in a throwaway in-memory database, the
  budget-owned dispatcher and the Meta/OpenRouter adapters with their
  transport checks (`src/server/budget`, `src/server/models`);
- the app's own answer parsers (`resolveProofread`, `parseCleanup`,
  `parseEvaluation` and `computeVerdict`).

A request the app would refuse, for example an unpriced model, is refused here
too. `--dry-run` swaps only the network call for the app's mock provider.

## Run it

Dry run first (no key, no network, no cost):

```bash
npx tsx eval/bench/run.ts --role proofread --dry-run --limit 5
```

Live runs read keys from the environment only. Run one role at a time; each
command below is one full run of that role.

**gpt-oss-120b preset on OpenRouter** (production fast tier):

```bash
OPENROUTER_API_KEY=sk-or-v1-... npx tsx eval/bench/run.ts --role proofread --provider openrouter --model @preset/gpt-oss-120b-balanced --max-usd 1
```

Use `--role dictation` or `--role evaluation` for the other roles. The preset
belongs to the owner's OpenRouter account, so it needs that account's key.

**gpt-oss-120b without the preset** (the app's default routing for a plain
model id):

```bash
OPENROUTER_API_KEY=sk-or-v1-... npx tsx eval/bench/run.ts --role dictation --provider openrouter --model openai/gpt-oss-120b --max-usd 1
```

**Meta Muse Spark, direct** (production smart tier):

```bash
META_API_KEY=... npx tsx eval/bench/run.ts --role evaluation --provider meta --model muse-spark-1.3 --max-usd 1
```

Spark on proofreading needs a higher cap; see the cost table below:

```bash
META_API_KEY=... npx tsx eval/bench/run.ts --role proofread --provider meta --model muse-spark-1.3 --max-usd 3
```

**Muse Spark through OpenRouter:**

```bash
OPENROUTER_API_KEY=sk-or-v1-... npx tsx eval/bench/run.ts --role dictation --provider openrouter --model meta/muse-spark-1.3 --max-usd 1
```

**DeepSeek or any other OpenAI-compatible endpoint** (direct API or a
reseller). Add a price first (see below), then:

```bash
BENCH_API_KEY=... npx tsx eval/bench/run.ts --role proofread --provider openai --base-url https://api.deepseek.com/v1 --model deepseek-chat --max-usd 1
```

The app sends a strict `json_schema` response format. If an endpoint does not
support it (DeepSeek's own API has historically offered only `json_object`),
every call fails with an HTTP 400, the run stops after five failures at no
cost, and that result means the app could not use the endpoint without a code
change.

**DeepSeek through OpenRouter** (add a price for the OpenRouter id first):

```bash
OPENROUTER_API_KEY=sk-or-v1-... npx tsx eval/bench/run.ts --role proofread --provider openrouter --model deepseek/deepseek-chat-v3.1 --tier smart --max-usd 1
```

Check the exact model id on openrouter.ai before you run. Why `--tier smart`:
for a plain model id on the fast tier, the app's OpenRouter adapter caps the
upstream price at $0.16 / $0.65 per million tokens and asks for low reasoning
effort. Few DeepSeek providers fit that, so OpenRouter may answer HTTP 404.
That is a real finding: the app as written could not use that model on the
fast tier. With `--tier smart` the cap is the model's table price and no
reasoning effort is sent for proofreading and dictation.

### Adding a price for a new model

The app never calls a model without a price, and neither does the bench. To
try a model, add one line to `mutableModelPrices` in
`src/server/models/prices.ts` in your local checkout, using the provider's
current list price and including its source and the date you checked it:

```ts
// DeepSeek, https://api-docs.deepseek.com/quick_start/pricing (checked YYYY-MM-DD)
"deepseek-chat": { kind: "text", inputUsdPerMTok: <input price>, outputUsdPerMTok: <output price> },
```

Use the cache-miss input price. OpenRouter models need their OpenRouter id as
the key (for example `"deepseek/deepseek-chat-v3.1"`), priced at the highest
listed provider price. Do not commit the line unless you mean to make the
model available to the app.

For OpenRouter models already in the table, `--price-in`/`--price-out` can
raise the price bound (never lower it), mirroring
`OPENROUTER_FAST_PRICE_IN_PER_M`/`OPENROUTER_FAST_PRICE_OUT_PER_M`.

### Options

| Flag | Default | Meaning |
|---|---|---|
| `--role` | required | `proofread`, `dictation` or `evaluation` |
| `--provider` | `openrouter`; `meta` for `evaluation` | `openrouter`, `meta` or `openai` (any OpenAI-compatible endpoint). Env `BENCH_PROVIDER` |
| `--model` | `@preset/gpt-oss-120b-balanced` / `muse-spark-1.3` | Model id or OpenRouter preset. Env `BENCH_MODEL` |
| `--base-url` | Meta: `https://api.meta.ai/v1` | Endpoint for `meta` and `openai` (required for `openai`). Env `BENCH_BASE_URL` |
| `--tier` | role's tier | `fast` or `smart`; changes reasoning and OpenRouter routing settings exactly as in the app |
| `--max-usd` | 1 | Hard spend stop, at most 50. Env `BENCH_MAX_USD` |
| `--limit`, `--offset` | all items | Run a slice of the dataset |
| `--concurrency` | 1 | Parallel calls, at most 8. Keep 1 for clean latency numbers |
| `--timeout-ms` | 60000 | Per-call deadline. The app uses 20000; slower calls are counted in the report |
| `--max-consecutive-failures` | 5 | Stop after this many failed calls in a row |
| `--out` | `eval/bench/results` | Output directory |
| `--dry-run` | off | Use the app's mock provider |

Keys: `OPENROUTER_API_KEY`, `META_API_KEY`, `BENCH_API_KEY` (for `openai`).
They are read from the environment, never from flags, and never written to
the output files.

Exit codes: 0 finished, 2 refused before any call (bad flags, missing key,
unpriced model), 3 stopped early (cost cap or repeated failures; the report is
still written), 1 unexpected error.

## Cost safety

- **Hard stop.** Before each call the bench computes the app's own upper
  bound for that call (`estimateMaxCostMicros`: input size as `chars × 3 + 600`
  tokens plus the role's full `max_tokens` of output, times 1.25, at the table
  price). A call is sent only while *spent so far + bounds of calls still in
  flight + this call's bound* stays at or below `--max-usd`. So spend cannot
  exceed the cap, even with `--concurrency` above 1.
- **What counts as spent.** The cost the provider reported (OpenRouter does),
  else tokens times the table price, else the full bound (for timeouts and
  dropped connections, where the provider may have billed). An HTTP refusal
  counts as zero.
- **Early stops.** The run stops after `--max-consecutive-failures` failures in
  a row (for example a provider that rejects the strict JSON schema), and at
  once if the app refuses a call.
- **Before you start**, the bench prints the worst-case bound for the selected
  items. That is a ceiling, not an estimate: real cost is usually 5 to 20 times
  lower.
- Try `--limit 10` first with a new model.

### Expected cost of one full run

Estimates come from the measured runs of 2026-11-03 (`eval/results`) and the
dataset sizes. Treat them as rough.

| Role (items) | gpt-oss-120b preset | Muse Spark 1.3 | Worst-case bound, preset / Spark |
|---|---:|---:|---:|
| proofread (200) | about $0.02 | about $1 to $1.5 | $5.54 / $10.77 |
| dictation (51) | under $0.01 | about $0.10 | $0.39 / $0.80 |
| evaluation (66) | about $0.01 | about $0.25 | $1.27 / $2.55 |

For a newly priced model, estimate per item about 1,800 input tokens for
proofreading, 300 for dictation and 900 for evaluation, plus 300 to 1,200
output tokens (reasoning models are at the high end). Multiply by the price
and the item count.

## Reading the summary

Each run prints a **comparison row** and writes it at the top of the report.
Paste rows from several runs into one table to compare models:

| Column | Meaning |
|---|---|
| Items | Calls attempted |
| Valid answers | Calls that returned an answer the app could parse |
| Quality | The role's headline metrics (below) |
| p50 / p95 | Network latency of successful calls, as measured by the app's transport. Nearest-rank percentiles |
| Cost per item | Accounted cost divided by attempted items |
| Full-run cost | Cost per item times the dataset size, useful after a `--limit` run |

**Proofreading.** Only the app's "error" suggestions are scored (optional
style and expression suggestions are counted, not scored). Expected mistakes
and model edits that overlap are grouped, and the resulting words are compared
with the accepted fixes, so it does not matter whether the model fixes two
neighbouring mistakes in one edit or one mistake in two.

- *Near match* ignores case, quote style, commas and spacing; *exact match*
  compares character for character.
- *Precision*: share of the model's edits that belong to a correct fix.
  *Recall*: share of expected mistakes fixed. Failed calls count as "no edits",
  so they lower recall.
- *Clean flagged*: clean texts that got at least one error edit. Every one is a
  false alarm a learner would see.
- *Items fully right*: every mistake fixed and nothing else touched.

**Dictation.** The model's text is scored even when the app would reject it.

- *Edit distance*: character-level Levenshtein distance to the closest
  accepted clean text, divided by the longer length. 0 is identical; 0.05 is
  roughly a missing comma and a capital letter in a short sentence.
- *Words kept*: no word was added that the speaker did not say, every expected
  word is still there, and every must-keep term (names, numbers, negations,
  non-English words) survived.
- *App accepted*: the app's `parseCleanup` took the answer. When it does not,
  the learner gets the raw transcript, so this is the share of dictations that
  actually got cleaned.

**Evaluation.** The verdict is computed by the app's `computeVerdict` from the
model's facts.

- *Acceptable*: the verdict is one of the item's acceptable verdicts (some
  borderline items accept two).
- *False passes*: `used_well` where it is not acceptable, the worst error for a
  learner. The report also breaks accuracy down by group (correct, form,
  wrong-meaning, not-used, mention, off-task, injection) and shows an
  expected → got matrix.

**Speed and cost section.** Failures by code (`http_400`,
`timeout_timeout`, `truncated`, `unparsable_answer`, ...), the number of
successful calls slower than the app's 20 s deadline, tokens, and three costs:
accounted (what the guard counted), provider-reported, and tokens × table
price. For the gpt-oss preset the table price is a deliberately conservative
bound, so the reported cost is the real one.

The report ends with every item that was not fully right, showing what was
expected and what the model did. The JSONL file holds the full record per
item, including the model's raw answer (cut to 4,000 characters).

## Datasets

One JSON object per line. The loader validates every line and refuses the
whole file on a problem, so a typo cannot silently change the answer key.

- `proofread.jsonl`: `id`, `group` (`error` or `clean`), `register` (`email`,
  `chat`, `note`), `text`, `errors` (`span`: a substring that occurs exactly
  once, `fixes`: accepted replacements for the whole span, `topic`). Spans must
  not overlap; texts must already be NFC-normalized, as the app's ranges
  require. Apart from the listed errors, each text must be correct.
- `dictation.jsonl`: `id`, `transcript`, `expected`, optional `accept`
  (other acceptable clean texts), `keep` (terms that must survive) and `note`.
  Every expected word must have been spoken: the app rejects answers that add
  words.
- `evaluation.jsonl`: `id`, `group`, `expression`, `meaning`, `situation`,
  `answer`, `expected`, `acceptable`, `note`.

All texts were written for this bench. The scorers have unit tests in
`tests/eval/bench-scorers.test.ts`; the runner, the cost guard and the dry run
are tested in `tests/eval/bench-runner.test.ts`.

## Limits

- One run is one sample at temperature 0 (the evaluation role's setting).
  Providers are not fully deterministic; repeat a run before trusting a small
  difference.
- Latency depends on time of day and on which upstream provider OpenRouter
  picked. The report lists the serving provider per item in the JSONL file.
- Answer keys are one author's judgement. Near matching and accepted variants
  reduce, but do not remove, penalties for valid alternative fixes; read the
  "not fully right" list before concluding that a model is worse.
- Speech-to-text is not covered yet; this bench starts at the transcript.
