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

- **Local first, cloud on request.** Rule-based checking runs in the browser. Cloud model calls happen only when the learner presses a button.
- **The model proposes, code decides.** Models return corrected sentences or replacement fragments; positions, diffs and validity checks are computed by deterministic code.
- **Help is not knowledge.** An accepted suggestion is recorded as assisted use. Only an unprompted later attempt counts as the learner producing the expression.
- **Every external call is paid for in advance.** A budget reservation is made before the call and settled after it.

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

1. **Per-learner daily quotas** by kind: `proofread` and `evaluate` (operations) and `asrSeconds`. Limits come from the learner's quota profile.
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
| `POST /api/proofread` | Cloud proofreading of the current text |
| `POST /api/suggestions/{id}` | Record accepted, rejected or stale |

Request and response schemas are in `src/shared/contracts.ts`. Errors use `{ error: { code, message } }` with a short learner-safe message.

## Models

Text jobs run on one of two tiers. A role (a kind of job) fixes its tier, an
explicit `max_tokens` and a price used for the cost upper bound. Chat roles
reserve 4096 output tokens, including reasoning. The input reservation uses a
conservative UTF-8 byte bound rather than an average English token ratio. A
model without a known price is never called. There is no automatic fallback to
another provider or tier: a job whose tier cannot be served is refused.

| Tier | Hosted (operator-funded) | Visitor (BYOK, OpenRouter) | Reasoning |
|---|---|---|---|
| fast | OpenRouter with the operator's `OPENROUTER_API_KEY`; model or preset from `OPENROUTER_FAST_MODEL`, default `openai/gpt-oss-120b` | `openai/gpt-oss-120b` | low |
| smart | Meta Muse Spark directly | `meta/muse-spark-1.3` | the role's setting |

| Role | Tier |
|---|---|
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
