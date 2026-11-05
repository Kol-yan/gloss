# Architecture

gloss is one Next.js application with a SQLite database on a persistent disk. The same Docker image runs the hosted instance and self-hosted installs.

```text
Browser                                   Server (Next.js route handlers)
├─ Editor + rule checker (WASM worker)    ├─ Session and invites
│   local suggestions, never uploaded     ├─ Budget: quotas + daily spend ceiling
├─ Practice: writing and voice            ├─ Proofread, practice situations (fast tier)
└─ History                                ├─ Evaluation of answers, dictation clean-up (smart tier: Meta Muse Spark)
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

Every cloud action requires an authenticated learner; there is no default learner.
The app opens immediately and automatically requests a guest session through
`POST /api/access/guest`. When configured, Turnstile is verified on the server
before enrollment. Production enrollment refuses missing verification keys.
The configurable daily guest cap (default three, maximum fifty) uses IPv4 addresses
and IPv6 /64 networks. Desktop enrollment also has a global rolling hourly cap
(default twenty, counting all guest enrollments). Limits are recorded atomically in
SQLite; only an explicitly trusted proxy can supply `CF-Connecting-IP`.

Settings accepts a browser-held OpenRouter key through `POST /api/access/byok`.
Adding a key upgrades the current learner without losing history. Funding can
move only from hosted to BYOK; request headers cannot move it back to the
operator's keys. Historic ledger rows retain their original funding source.
`POST /api/access/signout` revokes the current session so an invite can be opened
with a different account. Both access endpoints require a same-origin empty JSON
object, and enrollment is rate limited.

- `GET /join/{token}` only shows a page with a Continue button, so link previews and scanners cannot spend an invite. The button posts to `/join/{token}/continue`, which redeems the invite, creates a learner and a session, sets a host-only session cookie (httpOnly, Secure in production, SameSite=Lax; development names include the port) and answers 303 to `/`. That POST must be same-origin (`Sec-Fetch-Site`, `Origin`), and an existing learner receives the upgraded allowance without losing history or changing BYOK funding.
- Session and invite tokens are random 32-byte values; only their SHA-256 hashes are stored. Sessions renew for 365 days on use; `/api/me` refreshes the browser cookie.
- Every learner-owned row has `learner_id`, and every query filters by the learner from the session.
- `npm run invite -- --label <name> --uses <n> --profile <pilot|judge|owner>` prints an invite link.

## Budget

Three independent limits protect the operator's API credits:

1. **Per-learner daily quotas** by kind: `proofread`, `detect` and `evaluate` (operations) and `asrSeconds`. Detector and generator operations count separately, and each profile sets both limits (`QUOTA_PROFILES` in `src/server/config.ts`). Writing a practice situation counts toward `evaluate`; dictation clean-up counts toward `proofread`.
2. **A daily spend ceiling** for the whole instance (`DAILY_BUDGET_USD`, default $5, UTC).
3. **A persistent period ceiling** (`PERIOD_BUDGET_USD`, default $25). All hosted ledger history counts, so a restart or UTC day change cannot reset it.

Guests have 30 checks, a separate 30-operation detector allowance, three practice
sessions and 300 audio seconds per UTC day. Owner funding expires at
`OWNER_FUNDED_UNTIL` when explicitly configured; there is no default expiry. After a quota, ceiling or
expiry, the action points to Settings so a visitor can use their own key.

Before a model call, `reserve()` runs in one `BEGIN IMMEDIATE` transaction: it checks the kill switch, the learner quota and `reserved + actual + maxCost <= ceiling`, then inserts a reservation. `maxCost` is an upper bound from the bounded input size, the role's explicit
`max_tokens`, and the configured price with a 1.25 safety margin. Audio is limited
to 60 seconds per request. After the call, `settle()` lowers a charge only for a
strictly positive provider-reported cost; missing or zero cost retains the bound. If the outcome is unknown (timeout, dropped connection), the reservation stays counted, because the provider may have done the work. Retries are new reservations.

When the ceiling is reached or `AI_ENABLED=false`, cloud features report `ai_disabled` or `budget_exhausted` and the editor keeps working with local checks.

The mandatory transport in `src/server/budget/provider-request.ts` checks the
stored reservation and consumes a durable one-time dispatch claim before any
provider network request. Calls without a reservation, duplicate dispatches,
under-reserved inputs, changed funding, expiry, a disabled switch or any ledger
failure refuse the network request. Model adapters cannot bypass this transport.

`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, when both are configured, send
asynchronous owner alerts through the Telegram Bot API at 50%, 80% and 100% of
the daily cap and a guest-enrollment burst alert; the token is never logged.
Notification errors do not change request results. `npm run spend:report` prints charged daily and period
spend by role plus guest counts.

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
| `POST /api/onboarding/level` | Store the CEFR level chosen on the Level step |
| `GET /api/onboarding/word-check` | The Word check round with its served answers and the stored level |
| `POST /api/onboarding/word-check` | Store Word check answers and the level estimate |
| `POST /api/suggestions/{id}` | Record accepted, rejected or stale |

Request and response schemas are in `src/shared/contracts.ts`. Errors use `{ error: { code, message } }` with a short learner-safe message.

`POST /api/detect` accepts 1–8 hashed sentences with at most 6,000 UTF-16 text units total and optional local-rule ranges. Its response contains probabilities only; `detect_runs` retains a fingerprint and decisions, not sentence text. Detector calls use their own `detect` quota. `/api/me` reports hosted AI disabled when the owner OpenRouter key is missing or malformed; BYOK availability still uses the visitor's browser-held key and the global kill switch.

## Models

Text jobs run on one of two tiers. A role (a kind of job) fixes its tier, an
explicit `max_tokens` and a price used for the cost upper bound. Chat roles reserve 4096 output tokens, including reasoning; detection,
learning proposals and dictation cleanup reserve 2048. The input reservation uses a
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
| Dictation clean-up | smart |
| Speech-to-text | Meta Muse Voice Transcribe (`meta/muse-voice-transcribe-1.0` for visitors) |

The fast tier asks OpenRouter for strict `json_schema` output, low reasoning,
an explicit `max_tokens`, supported parameters and usage accounting. Owner-funded
routes must use a known model from the price table. Opaque presets and unknown
model IDs are refused because they cannot demonstrate a worst-case bound.
Configured prices cannot lower the table's bound. OpenRouter routing uses maximum
provider prices; a missing hosted key refuses the role without a fallback.
A positive reported `usage.cost` settles the reservation; missing or zero cost
retains the full reservation, including its safety margin.

Successful proofreading rows also retain OpenRouter's returned serving provider
and the settled cost in micro-dollars. The audit log records provider, model,
latency and settled cost without logging learner text.

Model output is validated against a JSON schema. Learner text is passed as data inside clear delimiters; models have no tools and cannot change the rubric.

For end-to-end tests only, `GLOSSY_MODEL_MOCK=true` replaces the network call in
`sendProviderRequest` with deterministic simulated providers
(`src/server/models/mock-provider.ts`). Routing, reservations, parsing and error
handling still run. It is off by default.

BYOK uses OpenRouter with the visitor's key for both tiers and transcription.
Speech requests use JSON `input_audio` with base64 WAV data. The adapters request
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

**Estimating a band for added words (provisional).** A word that arrives from
the learner (My words), from Word check or from a model has no curated band. The
estimate below is implemented in `src/server/learning/priority/intake.ts` and
used for every word without a curated band; a curated band always wins. It uses
no corpus and no network call, needs no data file and no third-party licence,
and is provisional: it is a rough order of magnitude, never shown to the learner
as a score, and the owner can override any band with a curated value.

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
with few daily tags and nothing more. It is the provisional default for words
without a curated band, it is not part of the B2 starter set, and the same rule
can be swapped for a licensed frequency table later behind the same band names
without changing the stored band vocabulary.

## Word engine: statuses, priority and the session

`src/server/learning/priority/` ranks the words a learner should practise next
and updates them when they answer. The pure rules live in `rules.ts` (status and
ladder transitions) and `scheduler.ts` (priority and the session mix); the
database code is confined to `engine.ts`, so most tests need no database.

A word is a saved expression, a starter entry or a Word check word. Statuses:
Learning, Ready to activate (known but not used), Active and Hidden. Active is
reached after 2 uses in the learner's own writing, which outweigh any exercise,
or after 3 correct unassisted productive answers. Real use is synced from the
Learning tab's independent-writing evidence per distinct document, so the same
document is never counted twice; it is never recorded from practice. Evidence is
collected over every expression whose text matches the word, so writing recorded
under a saved id and under a starter id of the same text counts once as the one
word. Two errors
in a row move a word one step down (Ready to Learning, Active to Ready); the
error streak then restarts, and the demotion resets the productive credit so the
same stale answers cannot reactivate the word. Reactions: Already know makes the
word Active with a rare check (14 days at most), Not relevant hides it, Too hard
moves it one rung down and brings it back tomorrow, Too easy jumps the word to
productive work. Rungs 1-6 are recognition, choice by meaning, gap fill, recall
from memory, use in a situation and speaking; rung 1 is the entry rung, and a
correct recognition lifts the word to rung 2. Hinted answers are assisted work:
they can move the status to Ready but do not lift the rung and are not
productive credit.

The order combines frequency band (curated for starter entries, the documented
estimate for other words), what the learner did (saved or added, Word check
answers, "too easy", repeated errors) and progress. Edge words (Ready) come
first. A session of 8 is 3 activate, 3 learn and 2 keep fresh. At most 3 words
are started as brand-new per day; the number drops to 1 when six or more
reviews are due or the recent answer share is below half (over four answers).
A word takes one of the day's places when it is first shown, so a second
session the same day does not start more. The daily three brand-new words
include Word check "new" answers, which spend their place at Word check time.
The learner sees one short reason such as "Common word - you know it but don't
use it yet", never a score.

Word origin and frequency-band source are tracked separately later; today a
saved word matching a starter entry keeps the starter source.

`db/migrations/0010_word_engine.sql` stores per-learner word state
(`word_progress`) and answers (`word_practice_events`). Statuses, bands and the
rung are integers or short strings with CHECK constraints; every row carries
`learner_id` and a foreign key on the learner.
`db/migrations/0011_word_real_use.sql` adds `real_use_documents`,
`real_use_days`, `real_use_last_at` and `word_check_answer` to `word_progress`;
the first two mirror distinct evidence documents and days, the last keeps the
Word check answer that decides whether a word is brand new.
`db/migrations/0012_onboarding_level.sql` adds `learners.level`, the Word check
level estimate, plus `word_progress.level` (the starter level a word was served
at) and the `word_check_entries` table of rounds described below.

Practice sessions use the same engine through `src/server/practice/word-source.ts`.
There is one status and schedule per word, in `word_progress`; the compatibility
table in `0013_practice_word_progress.sql` is unused by the application.
`0014_practice_exercise_pool.sql` and `0015_practice_sessions.sql` reference the
engine's learner-owned word identities, so starter and Word check words do not
need synthetic saved expressions. Their definitions come from the curated set;
IPA remains unavailable when there is no saved pronunciation data. Engine word
IDs stay stable when a saved expression with the same normalized text arrives.

Session creation checks its request ID before selecting words, in the same
transaction that reserves the day's new-word places. Answers update the engine
and the session item atomically. A later reaction annotates that answer event
without adding another answer or productive credit. The current exercise pool
serves rungs 1-4; words at engine rungs 5-6 receive rung-4 recall, and the event
records the exercise actually served.

## Onboarding: level and Word check

Onboarding has a Welcome step, a Level step, Word check, the Word check result,
Your tools and Ready. The owner removed the Goals and topics screen (Nov 3), so
there is no topics API and nothing reads a topic choice; personal relevance
comes from Word check answers and the learner's own writing and saved words.
`learners.level` (`A2`, `B1`, `B2`, `C1`; NULL before the first estimate) is
the single stored level. Two writers feed it, and the rule is:

1. **The Level step sets the starting point.** `POST /api/onboarding/level`
   accepts `{ level }` with a legacy `A2`/`B1`/`B2`/`C1` level or a named
   group (`proficient`, `advanced`, `intermediate`, `elementary`, `unsure`)
   and writes the canonical `learners.level`. The groups map to engine
   levels `C1`, `B2`, `B1`, `A2` and `B1` respectively (`proficient` shows
   `C2` as `Proficient or native`, `advanced` covers `B2–C1`,
   `intermediate` is `B1`, `elementary` covers `A1–A2`); the typed
   definitions, labels, ranges and mapping live in `src/shared/contracts.ts`
   (`ONBOARDING_LEVEL_GROUPS`) for later UI consumers. The response is
   always the canonical `A2`/`B1`/`B2`/`C1` level. The first
   Word check round is built around that choice. It has no GET: the stored
   level travels in the Word check response.
2. **Word check answers refine it.** Every `POST /api/onboarding/word-check`
   recomputes `learners.level` from all answers so far (see the estimate
   below) and overwrites the choice. The explicit choice is therefore only the
   starting point: once the learner has answered, the estimate wins, and a
   later visit to the Level step sets a new starting point for the next round.

A round is frozen once served: a level chosen after the first `GET` moves the
next round, never the current one, so the ids the page already holds keep
answering the same words.

**Word check API.** `GET /api/onboarding/word-check` serves a round of 24
curated starter entries built around the stored level (or `B1` when it is
NULL). The round is eight entries from the level below, eight from the
learner's level and eight from the level above; at A2 it is sixteen A2 and
eight B1, at C1 eight B2 and sixteen C1. A level can run short after a long
history, so the round is filled from any remaining entries and may be smaller
than 24. Words the learner already answered in any round, and words they
already keep, are not offered again; ties prefer the fewest showings, then the
longest unshown, then alphabetical order, so the round is deterministic. The
round is persisted in `word_check_entries` and reused for the rest of the UTC
day.

The response is `{ entries, roundSize, answered, completed, level }`. Every
entry carries `answer`: the answer already recorded for it in this round, or
null while it is still open. So a reload never asks an answered word again - a
finished round comes back with `completed: true` and every entry answered, a
partial one with `answered` up to 24 and only the open entries null. Every row
carries `learner_id`; nothing is shared between learners.

`POST /api/onboarding/word-check` accepts `{ answers: [{ id, answer }] }` with
1 to 24 answers, each id taken from a round this learner was served; any id
from another learner or an invented one rejects the whole request before
anything is written, and the same id twice is rejected. The answer mapping is
fixed:

| Answer | Meaning | Stored |
|---|---|---|
| `use` | I use it | Known vocabulary: no My words row and never in a practice session; the round row keeps the answer for the estimate and to avoid re-asking |
| `know_unused` | I know it, I don't use it | Ready to activate (`word_progress.status = 'ready'`) |
| `not_sure` | I'm not sure | Learning |
| `new` | New to me | Learning, and it takes one of the day's three brand-new places |

A word the learner already keeps (a saved expression or a starter word) keeps
its own state; the answer records the level evidence but never demotes it. The
response is the new level, the number of answers and counts of `active`
(the "use" answers: known vocabulary, not the Active status of a word),
`ready` and `learning`. A repeated POST is idempotent: the word rows are keyed
by the learner's normalized text and keep their first answer, so no word,
brand-new place or count changes.

**Level estimate.** Each answered word is one line drawn from its curated
level: `use` adds one level, `know_unused` adds nothing, `not_sure` subtracts
one and `new` subtracts two. The estimate is the mean over every word the
learner has answered, rounded down and clamped to A2-C1; with no answers it is
B1. It is cumulative, so a later round refines an earlier estimate without a
separate history. The rule is deliberately coarse: it separates adjacent
levels and nothing more. It never flatters a learner (a mean of 1.9 is B1) and
is documented here so the product can change it in one place.

### Onboarding interface and completion

The six-step interface lives at `/onboarding`: Welcome, Level, Word check,
Word map, Your tools and All set. Only `/practice` checks completion and
redirects an unfinished learner to onboarding. The editor, saved expressions,
extension and dictation remain available independently. Development-only
practice fixtures remain local previews.

The interface submits each answer through the existing Word check API before
moving on. Reloading retrieves the stored round and continues with its first
unanswered entry. Word map places only entries answered `know_unused` on the
line; it does not pretend that a new or already active word is on that edge.
The response optionally includes the curated example sentence. Missing IPA
remains visibly unavailable, and pronunciation uses the existing local voice
controller.

`POST /api/onboarding/complete` accepts an empty object and records completion
for the current learner only, after a served Word check round is fully answered.
Completion persists in SQLite and is idempotent. The final button waits for
that response before navigating to `/practice`, which starts the existing
practice session flow. Completion requires no model request.

The word-line illustration is a client component with a bounded dot population,
animation-frame drift, word labels, crossings and an eight-segment closing morph.
It cancels its frames and Web Animations on cleanup. Reduced motion uses a
static arrow and the final progress bar; resizing resets the illustration and
finishes the closing morph immediately. The shared brand lockup uses a teal
tile and a locally served Brygada 1918 font (SIL Open Font License).

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
