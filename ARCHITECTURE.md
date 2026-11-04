# Architecture

gloss is one Next.js application with a SQLite database on a persistent disk. The same Docker image runs the hosted instance and self-hosted installs.

```text
Browser                                   Server (Next.js route handlers)
├─ Editor + rule checker (WASM worker)    ├─ Session and invites
│   local suggestions, never uploaded     ├─ Budget: quotas + daily spend ceiling
├─ Practice: writing and voice            ├─ Proofread, practice situations (fast tier)
└─ History                                ├─ Evaluation of answers (smart tier: Meta Muse Spark)
                                          ├─ Speech-to-text (Meta Muse Voice Transcribe)
                                          └─ SQLite
```

## Principles

- **Local first, cloud on request.** Stage 0 rule-based checking runs in the browser. The server supports detection of changed sentences after a typing pause; generation remains an explicit action.
- **The model proposes, code decides.** Models return corrected sentences or replacement fragments; positions, diffs and validity checks are computed by deterministic code.
- **Help is not knowledge.** An accepted suggestion is recorded as assisted use. Only an unprompted later attempt counts as the learner producing the expression.
- **Every external call is paid for in advance.** A budget reservation is made before the call and settled after it.

The detector API returns category probabilities for changed sentences and creates no suggestion. An explicit generator action requests a whole-sentence correction; the existing deterministic diff then builds the suggestions.

## Text and ranges

The client normalizes text with `normalizeText` (NFC, `\n` line endings) before checking or sending it. Ranges are UTF-16 indices into that normalized text. A suggestion carries the original fragment and can be applied only if `text.slice(start, end) === original`; otherwise it is stale and discarded. Edits that change numbers, negation or names are flagged `meaningChange` and are never applied in bulk.

## Identity

There is no anonymous access to cloud features and no default learner.

Visitors can start a separate BYOK workspace through `POST /api/access/byok`.
The learner's immutable database funding source selects hosted Meta access or
visitor-funded OpenRouter access; headers cannot change that funding source.
`POST /api/access/signout` revokes the current session so an invite can be opened
with a different account. Both access endpoints require a same-origin empty JSON
object, and enrollment is rate limited.

- `GET /join/{token}` only shows a page with a Continue button, so link previews and scanners cannot spend an invite. The button posts to `/join/{token}/continue`, which redeems the invite, creates a learner and a session, sets the `glossy_session` cookie (httpOnly, Secure in production, SameSite=Lax) and answers 303 to `/`. That POST must be same-origin (`Sec-Fetch-Site`, `Origin`), and a browser that already has a valid session is sent home without redeeming.
- Session and invite tokens are random 32-byte values; only their SHA-256 hashes are stored.
- Every learner-owned row has `learner_id`, and every query filters by the learner from the session.
- `npm run invite -- --label <name> --uses <n> --profile <pilot|judge|owner>` prints an invite link.

## Budget

Two independent limits protect the operator's API credits:

1. **Per-learner daily quotas** by kind: `proofread`, `detect` and `evaluate` (operations) and `asrSeconds`. Detector and generator operations count separately; each profile's `detect` limit matches its existing `proofread` limit.
2. **A daily spend ceiling** for the whole instance (`DAILY_BUDGET_USD`).

Before a model call, `reserve()` runs in one `BEGIN IMMEDIATE` transaction: it checks the kill switch, the learner quota and `reserved + actual + maxCost <= ceiling`, then inserts a reservation. `maxCost` is an upper bound from the input size, the role's `max_tokens` and the configured price. After the call, `settle()` records the actual cost from reported usage. If the outcome is unknown (timeout, dropped connection), the reservation stays counted, because the provider may have done the work. Retries are new reservations.

When the ceiling is reached or `AI_ENABLED=false`, cloud features report `ai_disabled` or `budget_exhausted` and the editor keeps working with local checks.

BYOK reservations retain daily learner quotas and the global kill switch, but do
not count toward the operator's dollar ceiling. They are additionally limited to
six reservations per minute and two pending calls per learner. Each ledger row
records its immutable funding source, so hosted and visitor costs stay separate.

The visitor's OpenRouter key is stored in their browser and sent transiently in
`X-Gloss-Provider-Key` for model requests. It is never stored in the database,
returned by an API, or written to application logs. Forgetting it preserves the
workspace and disables model calls until a key is entered again. A missing key
never falls back to the operator's credentials. Unexpected exceptions are logged
without their message or stack, which could contain sensitive data.

## Data model (stage 1)

```text
learners            id, display_name, quota_profile, created_at, deleted_at
invites             token_hash, label, quota_profile, max_uses, uses, expires_at, created_at
sessions            token_hash, learner_id, created_at, expires_at
settings            key, value                      -- e.g. ai_enabled
check_runs          id, learner_id, request_id UNIQUE(learner_id, request_id), text_hash,
                    text_length, provider, model, status, latency_ms, created_at,
                    serving_provider, settled_cost_micros
suggestions         id, check_run_id, learner_id, start, end, original, replacement,
                    category, reason, meaning_change, status, decided_at
usage_reservations  id, learner_id, kind, request_id UNIQUE(learner_id, kind, request_id),
                    units, max_cost_micros, actual_cost_micros, status, created_at, settled_at
```

Money is stored in micro-dollars (integers). Dates are UTC ISO strings; "today" for quotas and the ceiling is the UTC day.

## API (stage 1)

| Route | Purpose |
|---|---|
| `GET /join/{token}` | Invite page (does not redeem) |
| `POST /join/{token}/continue` | Redeem invite, start session |
| `GET /api/health` | Liveness: the database opens and migrations are applied |
| `GET /api/me` | Learner, quotas, whether cloud features are available |
| `POST /api/detect` | Classify changed sentences for correction, clarity and word choice |
| `POST /api/proofread` | Cloud proofreading of the current text |
| `POST /api/learning` | On-request opportunities to use saved expressions |
| `POST /api/expressions/writing` | Record deterministic, unassisted real-writing matches |
| `POST /api/suggestions/{id}` | Record accepted, rejected or stale |

Request and response schemas are in `src/shared/contracts.ts`. Errors use `{ error: { code, message } }` with a short learner-safe message.

`POST /api/detect` accepts 1–8 hashed sentences with at most 6,000 UTF-16 text units total and optional local-rule ranges. Its response contains probabilities only; `detect_runs` retains a fingerprint and decisions, not sentence text. Detector calls use their own quota, equal to the profile's existing proofreading limit. `/api/me` reports hosted AI disabled when the owner OpenRouter key is missing or malformed; BYOK availability still uses the visitor's browser-held key and the global kill switch.

## Models

Text jobs run on one of two tiers. A role (a kind of job) fixes its tier, an
explicit `max_tokens` and a price used for the cost upper bound. Chat roles
reserve 4096 output tokens, including reasoning; the detector role reserves
2048. The input reservation uses a
conservative UTF-8 byte bound rather than an average English token ratio. A
model without a known price is never called. There is no automatic fallback to
another provider or tier: a job whose tier cannot be served is refused.

| Tier | Hosted (operator-funded) | Visitor (BYOK, OpenRouter) | Reasoning |
|---|---|---|---|
| fast | OpenRouter with the operator's `OPENROUTER_API_KEY`; model or preset from `OPENROUTER_FAST_MODEL`, default `openai/gpt-oss-120b` | `openai/gpt-oss-120b` | low |
| smart | Meta Muse Spark directly | `meta/muse-spark-1.3` | the role's setting |

| Role | Tier |
|---|---|
| Sentence detection | fast |
| Saved-expression opportunities | fast (2048 output tokens, detect quota) |
| Proofreading | fast |
| Practice situations | fast |
| Evaluation of learner answers | smart |
| Speech-to-text | Meta Muse Voice Transcribe (`meta/muse-voice-transcribe-1.0` for visitors) |

The fast tier asks OpenRouter for a strict `json_schema` response, `reasoning`
effort `low`, an explicit `max_tokens`, `provider.require_parameters` (so routing
never lands on a provider without structured output), and `usage.include`. For a
model preset, the request adds only `provider.require_parameters` and leaves
routing to the preset. For a plain fast model ID, the request explicitly uses
throughput sorting, a prompt/completion `max_price` of 0.16/0.65, denied data
collection, provider fallbacks enabled, and `require_parameters`. The reservation
uses a price bound: `OPENROUTER_FAST_PRICE_IN_PER_M` and
`OPENROUTER_FAST_PRICE_OUT_PER_M`, or the default, which is twice the highest
per-token price any provider listed for gpt-oss-120b in November 2026. A preset
hides its provider, so a preset uses the same bound unless both prices are set;
any other model needs both prices or it has no bound and is refused. When the
call finishes, the reservation settles at the `usage.cost` OpenRouter reports,
or at the reported tokens times the bound's price when no cost is reported. A
missing `OPENROUTER_API_KEY` answers `ai_disabled` for fast jobs; Meta is never
used instead.

Successful proofreading rows also retain OpenRouter's returned serving provider
and the settled cost in micro-dollars. The audit log records provider, model,
latency and settled cost without logging learner text.

Model output is validated against a JSON schema. Learner text is passed as data inside clear delimiters; models have no tools and cannot change the rubric.

BYOK uses OpenRouter with the visitor's key for both tiers. The adapters request
providers that deny data collection; this routing preference is not a claim of
independently verified zero retention. There is no fallback to operator-funded
access when a visitor request fails.

## Proofreading

The model does not return independent fragment edits. For each sentence with a
definite mistake it returns the whole corrected sentence, with every fix applied
together, and a short note per fix. Optional style and expression suggestions
travel separately as `improvements` and are never mixed into the correction.

The server compares each original sentence with its corrected version word by
word (deterministic code in `src/server/proofread/diff.ts`), merges differences
that depend on each other (at most one word between them), and turns each
difference into one `error` suggestion. A note labels a difference by the words it
shares with it. Applying every error suggestion of a sentence, in any order,
gives exactly the corrected sentence, so checking the corrected text again finds
nothing new. A sentence is kept with all of its fixes or none. Improvements are
located as exact fragments of the original and dropped when they overlap an error
fix. A "verify" mode (a server option for re-checking corrected text; no API route
uses it yet) reports errors only: a sentence that comes back unchanged has no
suggestions.

## Two-stage checking in the editor

Stage 0 is the in-browser rule checker with the dictionary spelling rule switched off; it marks grammar and punctuation instantly in Checks. Stage 1 starts when the learner stops typing for about 800 ms. Sentences whose text changed, however short and with or without final punctuation, are sent in batches to `POST /api/detect`, together with the spans Stage 0 already marks. A sentence is identified by the SHA-256 of its normalized text, and the answer is cached under that hash, so unchanged sentences are never sent again and sentences that still have pending proofreading suggestions are skipped. Probabilities of at least 0.5 light the AI tab's count indicator. A detected sentence has no proposed edit and adds no underline of its own.

Stage 2 runs when the learner opens AI. Flagged sentences go to the proofreading generator one at a time and the resulting suggestions are placed back at each sentence's position, while other sentences' suggestions stay as they were. There is no per-flag analysis button. The card says "Analyzing…" until the answer arrives. Closing the phone sheet or leaving AI stops the unsent queue. Applying a cloud fix re-checks only the sentence it changed, after every fix, even when another cloud fix is still waiting in that sentence. Leaving the page or switching learner drops the unsent queue, and every detector request is checked against the signed-in learner just before it is sent. When the detector quota is used up or AI is off, automatic scanning stops for the session and the Check with AI button keeps working. Failed detector calls are not repeated for the same sentence.

## Learning in the editor

The suggestion panel is a controlled component with Checks, AI and Learning tabs.
Its host supplies data, callbacks, tab state and the website practice URL; it has
no session, routing or network dependency. It is reused in the phone bottom sheet.
Inline review, Apply, Dismiss, Undo and safe bulk corrections use the same editor
state across tabs. Learning has one website practice link. Saving a newly accepted
expression remains optional and does not navigate away from the editor.

Saved expressions are matched locally with whole-token English inflection rules,
including bounded irregular-verb forms. Independent matches light Learning and
produce short comments without a model call. Accepted replacement spans are
tracked through edits and Undo and excluded from these matches. Samples are
marked as supplied text. The server repeats matching against the authenticated
learner's expressions and excluded ranges before writing `independent_writing`
evidence, once per expression and editor document. This event has no attempt,
verdict or cue, does not change practice scheduling, and stores no draft text.
Accepting a suggestion containing an already-saved expression records assisted
use instead, once for that suggestion's acceptance.

Only opening Learning requests list-aware proposals. A separate fast-tier role
reserves 2048 output tokens and its maximum cost atomically against the detect
quota and normal daily ceiling. Spark and opaque model presets are refused for
this role because they cannot guarantee a non-Spark call. The server selects at
most 30 active saved expressions (currently all saved rows, newest first), and
sends their text and meaning as data alongside the current text. Nothing fitting
is the normal outcome; at most two proposals may specify exact UTF-16 replacement
spans. Code verifies the expression, exact span and the existing meaning guard.
The detector and proofreading prompt never receive the saved list. Opening an
unchanged text reuses the in-memory Learning result, including an empty answer;
editing while a request is pending cannot attach its answer to the wrong text.

## Starter set and frequency bands

The app ships a curated starter set of about 400 English entries: single words
and common expressions, each with a frequency band, a CEFR level (A2 to C1), a
definition of at most 12 words, one example sentence and up to three light topic
tags. The entries live in `src/server/learning/starter/` as original hand-written
data in four batches of 100. They are not taken from any published vocabulary
list, and the definitions and examples are our own wording. The dataset is
validated and ready; delivering the starter entries to a new learner depends on
the later integration task and no production caller serves them yet.

`loadStarterSet` (`src/server/learning/starter/schema.ts`) validates the set when
it is first used: required fields, accepted bands, levels and tags, printable
ASCII, a definition of 2 to 12 words that does not repeat the entry, an example
sentence that contains the entry (base or inflected form), at most one entry per
expression, and no two entries with the same stem. A broken edit fails the tests
and the first request rather than reaching a learner.

**Frequency source and licence.** We checked the licence of every candidate
frequency list before writing data. None of the lists that carry real word
frequencies is clean enough to embed here:

| Candidate | Licence of the data | Result |
| --- | --- | --- |
| wordfreq (rspeer) | Code Apache-2.0, data CC BY-SA 4.0; data frozen since 2021 | Share-alike; would need a separate CC BY-SA data file |
| hermitdave/FrequencyWords | CC BY-SA 4.0 | Share-alike |
| SUBTLEX-US (Brysbaert & New) | CC BY-NC-SA 4.0 on the author's OSF page | Non-commercial and share-alike |
| google-10000-english | Not an open licence; LDC terms, commercial use discouraged | Not clean |
| Google Books Ngram exports | CC BY 3.0 | Clean, but needs building a table from very large exports |
| Linguabase | CC0 1.0 | Clean, but ranks familiarity, not corpus frequency |

CC BY-SA 4.0 is a one-way compatible licence for GPLv3 only, so a derived band
table could not be relicensed under this repository's AGPL-3.0-only terms and
would have to stay a separate share-alike file. The cheapest route to clean data
(Google Ngram exports) needs processing of multi-gigabyte files, and Linguabase
measures how familiar a word feels rather than how often it is written. We
therefore do not embed any third-party list and no data file carries a
third-party licence; `THIRD_PARTY_NOTICES.md` is unchanged.

**How a band is assigned (curated).** Each entry is placed by hand into one
band, using the following definition, applied in order:

- `core` - function-like words and phrases met dozens of times a day in any
  writing, including beginner material ("on time", "right now", "decide").
- `common` - everyday vocabulary that a B1 learner meets most days, in general
  or workplace writing ("suggest", "temporary", "make a decision").
- `uncommon` - vocabulary that a B2 learner meets regularly but not daily, and
  mostly in one register ("negotiate", "reluctant", "keep track of").
- `rare` - lower-frequency but realistic words and idioms that a C1 learner
  meets in careful writing or speech ("meticulous", "inevitable", "cut corners").

Because the bands are curated, they are an editorial approximation of frequency,
not a measured Zipf value. They are consistent within the starter set and are
used only to order and explain words, never shown to the learner as a score. A
licensed frequency list could later replace the curated table behind the same
loader and band names.

**Estimating a band for added words (provisional, not implemented yet).** A word
that arrives later from the learner (My words), from Word check or from a model
has no curated band. The later integration task is expected to derive one with
the estimate below and store it with the word. Nothing in this task or in the
current code base implements that estimate: there is no inline closed list, no
runtime estimator, no database column and no migration for it, and the starter
loader (`src/server/learning/starter/`) only checks bands that are already
written in the data. The estimate uses no corpus and no network call, needs no
data file and no third-party licence, and is provisional: it is a rough order of
magnitude, never shown to the learner as a score, and the owner can override any
band with a curated value.

The rule is a single pass with no ambiguity. Define the input as the normalized
text (lower case, trimmed, inner whitespace collapsed to one space), an optional
set of tags drawn from the starter tag set (`work`, `time`, `people`,
`communication`, `money`, `travel`, `study`, `technology`, `daily`, `emotion`),
and the length `n` = number of ASCII letters in the normalized text. An input
with no tags is estimated as if it had the empty tag set. Apply exactly one of
the following cases, in this order, and stop at the first that matches:

1. The normalized text equals one item of the enumerated single-word list below
   (27 items, ASCII, lower case, compared after normalization). Result: `core`.
2. The normalized text equals one item of the enumerated expression list below
   (20 items, compared after normalization, so inner spacing does not matter).
   Result: `core`.
3. The normalized text contains at least one space. Result: `common` when the
   tag set contains `daily` or `time`, otherwise `uncommon`.
4. Otherwise (a single word, including unknown `ok`/`hi`-style short forms): base
   score 2, plus 1 if the tag set contains `daily` or `time`, plus 1 if
   `n <= 7`. Result by total score: 4 or more -> `core`; 3 -> `common`; 2 ->
   `uncommon`; 1 or less is impossible for this branch.

The enumerated lists (these are the exact, full lists; nothing outside them
counts as a list hit):

- single words: `a`, `an`, `and`, `are`, `at`, `be`, `but`, `by`, `can`, `do`,
  `for`, `get`, `go`, `have`, `he`, `here`, `how`, `i`, `in`, `is`, `it`,
  `look`, `make`, `me`, `my`, `no`, `not`.
- expressions: `a lot`, `again`, `at home`, `best wishes`, `a bit`, `all right`,
  `excuse me`, `good morning`, `good night`, `how are you`, `i think`, `in the
  end`, `never mind`, `of course`, `on time`, `right now`, `see you`, `thank
  you`, `the same`, `what about`.

Worked examples: `back` with no tags -> case 4, `n` = 4, score 3 -> `common`.
`ok` with no tags -> case 4, `n` = 2, score 3 -> `common`. `time` with the
`time` tag -> case 4, `n` = 4, score 4 -> `core`. `deadline` with no tags ->
case 4, `n` = 8, score 2 -> `uncommon`. `on time` -> case 2 -> `core`. `talk it
over` with the `daily` tag -> case 3 -> `common`. `talk it over` with no tags ->
case 3 -> `uncommon`. Tags do not affect cases 1-3, and case 4 never returns
`rare`.

This estimate is coarse: it separates very common short words from long words
with few daily tags and nothing more. It is one provisional default for the
later integration task, it is not part of the B2 starter set, and the same rule
can be swapped for a licensed frequency table later behind the same band names
without changing the stored band vocabulary.

## Word pronunciation

Single-word expression suggestions can carry American English IPA from the same
budgeted proofreading response. A bounded phonetic-syntax check rejects missing,
invalid or phrase-level data; it does not independently verify the pronunciation.
Nullable IPA persists with suggestions and expressions and is returned with shown
tasks and scored feedback. Old rows honestly display that IPA is unavailable.

Pronunciation plays only after a click, using an English voice the browser reports
as local. US voices are preferred; another local English accent is labeled when
used. The application does not call a speech-generation provider. Playback is
cancelled and blocked before microphone access, then unblocked when capture ends.
Hidden tasks and unavailable hidden feedback never reveal the word or its IPA.
Scoring rechecks recent reveals under the database lock, so a second preissued
hidden task cannot count as independent recall after another task shows the target.

## Selected text capture

The optional unpacked extension transfers a selection in an editor URL fragment,
never a query parameter. The editor consumes and clears that fragment after
hydration, normalizes plain text, and rejects more than 6,000 UTF-16 units without
truncation. It makes no automatic cloud call. Captured text stays in page memory,
survives the initial sign-in, and is cleared when its authenticated learner changes.
The extension stores only the configured editor origin, never credentials or text.

## Recovery and retention

Task generation claims a durable learner/request row before any paid work. A
generation token fences late workers after a stale claim is recovered. Explicit
retries after a failed generation get a new paid reservation; previous unknown
charges remain counted. Saving the task and completing the claim is atomic.

Check runs retain a text hash and length. Suggestions retain original and
replacement fragments, while practice retains tasks, answers, transcripts and
feedback. Raw audio is handled transiently, not stored. Treat the database and
backups as learner data; there is no automated retention/deletion policy yet.
