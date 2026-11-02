# Architecture

Glossy is one Next.js application with a SQLite database on a persistent disk. The same Docker image runs the hosted instance and self-hosted installs.

```text
Browser                                   Server (Next.js route handlers)
├─ Editor + rule checker (WASM worker)    ├─ Session and invites
│   local suggestions, never uploaded     ├─ Budget: quotas + daily spend ceiling
├─ Practice: writing and voice            ├─ Proofread (cloud model)
└─ History                                ├─ Practice tasks and evaluation (Meta Muse Spark)
                                          ├─ Speech-to-text (Meta Muse Voice Transcribe)
                                          └─ SQLite
```

## Principles

- **Local first, cloud on request.** Rule-based checking runs in the browser. Cloud model calls happen only when the learner presses a button.
- **The model proposes, code decides.** Models return replacement fragments; positions, diffs and validity checks are computed by deterministic code.
- **Help is not knowledge.** An accepted suggestion is recorded as assisted use. Only an unprompted later attempt counts as the learner producing the expression.
- **Every external call is paid for in advance.** A budget reservation is made before the call and settled after it.

## Text and ranges

The client normalizes text with `normalizeText` (NFC, `\n` line endings) before checking or sending it. Ranges are UTF-16 indices into that normalized text. A suggestion carries the original fragment and can be applied only if `text.slice(start, end) === original`; otherwise it is stale and discarded. Edits that change numbers, negation or names are flagged `meaningChange` and are never applied in bulk.

## Identity

There is no anonymous access to cloud features and no default learner.

- `GET /join/{token}` redeems an invite, creates a learner and a session, sets the `glossy_session` cookie (httpOnly, Secure in production, SameSite=Lax) and redirects to `/`.
- Session and invite tokens are random 32-byte values; only their SHA-256 hashes are stored.
- Every learner-owned row has `learner_id`, and every query filters by the learner from the session.
- `npm run invite -- --label <name> --uses <n> --profile <pilot|judge|owner>` prints an invite link.

## Budget

Two independent limits protect the operator's API credits:

1. **Per-learner daily quotas** by kind: `proofread` and `evaluate` (operations) and `asrSeconds`. Limits come from the learner's quota profile.
2. **A daily spend ceiling** for the whole instance (`DAILY_BUDGET_USD`).

Before a model call, `reserve()` runs in one `BEGIN IMMEDIATE` transaction: it checks the kill switch, the learner quota and `reserved + actual + maxCost <= ceiling`, then inserts a reservation. `maxCost` is an upper bound from the input size, the role's `max_tokens` and the configured price. After the call, `settle()` records the actual cost from reported usage. If the outcome is unknown (timeout, dropped connection), the reservation stays counted, because the provider may have done the work. Retries are new reservations.

When the ceiling is reached or `AI_ENABLED=false`, cloud features report `ai_disabled` or `budget_exhausted` and the editor keeps working with local checks.

## Data model (stage 1)

```text
learners            id, display_name, quota_profile, created_at, deleted_at
invites             token_hash, label, quota_profile, max_uses, uses, expires_at, created_at
sessions            token_hash, learner_id, created_at, expires_at
settings            key, value                      -- e.g. ai_enabled
check_runs          id, learner_id, request_id UNIQUE(learner_id, request_id), text_hash,
                    text_length, provider, model, status, latency_ms, created_at
suggestions         id, check_run_id, learner_id, start, end, original, replacement,
                    category, reason, meaning_change, status, decided_at
usage_reservations  id, learner_id, kind, request_id UNIQUE(learner_id, kind, request_id),
                    units, max_cost_micros, actual_cost_micros, status, created_at, settled_at
```

Money is stored in micro-dollars (integers). Dates are UTC ISO strings; "today" for quotas and the ceiling is the UTC day.

## API (stage 1)

| Route | Purpose |
|---|---|
| `GET /join/{token}` | Redeem invite, start session |
| `GET /api/me` | Learner, quotas, whether cloud features are available |
| `POST /api/proofread` | Cloud proofreading of the current text |
| `POST /api/suggestions/{id}` | Record accepted, rejected or stale |

Request and response schemas are in `src/shared/contracts.ts`. Errors use `{ error: { code, message } }` with a short learner-safe message.

## Models

Each role has one configured provider and model, an explicit `max_tokens` (at least 2048) and a price used for the cost upper bound. There is no automatic fallback to another provider.

| Role | Default |
|---|---|
| Proofreading | Meta Muse Spark |
| Practice tasks and evaluation | Meta Muse Spark |
| Speech-to-text | Meta Muse Voice Transcribe |

Model output is validated against a JSON schema. Learner text is passed as data inside clear delimiters; models have no tools and cannot change the rubric.
