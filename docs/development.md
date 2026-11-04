# Development

## Requirements

- Node 26 (`.nvmrc`; `package.json` requires `>=26 <27`). The database uses
  the built-in `node:sqlite`.
- To use the cloud features: a Meta API key and an OpenRouter API key. The
  editor and its local checks run without either.

## Run locally

```bash
npm ci
```

```bash
cp .env.example .env.local
```

Fill in `.env.local`, then start the app:

```bash
npm run dev
```

Everyone needs an invite. Create one, open the printed `/join/…` link and press
**Continue**:

```bash
npm run invite -- --label me --uses 1 --profile owner
```

Migrations are applied when the database is first opened. The session cookie
is `Secure` in production only, so plain `http://localhost` works in
development. `/dev/states` shows every UI state with sample data; it is not
served in production.

## Configuration

`.env.example` lists every variable. Never commit real values.

| Variable | Purpose |
|---|---|
| `META_API_KEY` | Meta API key: answer evaluation, dictation clean-up and speech-to-text. |
| `META_API_BASE_URL` | Meta API base URL. |
| `META_TEXT_MODEL` | Meta text model for the smart tier. |
| `META_ASR_MODEL` | Meta speech-to-text model. |
| `OPENROUTER_API_KEY` | The operator's OpenRouter key: sentence detection, proofreading and practice situations. |
| `OPENROUTER_FAST_MODEL` | Optional fast-tier model or preset. |
| `OPENROUTER_FAST_PRICE_IN_PER_M`, `OPENROUTER_FAST_PRICE_OUT_PER_M` | Optional price bound for the fast model. Set both for any model other than the default. |
| `BYOK_TRUST_PROXY_HEADERS` | Trust the proxy's client-IP header for visitor enrollment limits. Only behind a proxy that overwrites it. |
| `AI_ENABLED` | Kill switch for every cloud model call. |
| `DAILY_BUDGET_USD` | Daily spend ceiling for the whole instance. |
| `GLOSSY_DATABASE_PATH` | SQLite file. Use a persistent disk outside development. |
| `GLOSSY_PUBLIC_URL` | Base URL printed in invite links and allowed to post the invite form. |

What works without keys:

| Keys set | Available |
|---|---|
| none | Editor with local grammar and punctuation checks, invites, history pages |
| `OPENROUTER_API_KEY` | Adds sentence badges, **Check with AI** and expression suggestions |
| both | Adds practice (situations from the fast tier, answers judged by Muse Spark), voice answers and dictation |

The runtime kill switch needs no restart:

```bash
npm run ai -- status
```

Use `npm run ai -- off` and `npm run ai -- on` to switch it.

For Docker, HTTPS, backups and invite profiles, see
[SELF_HOSTING.md](../SELF_HOSTING.md).

## Checks

Run all four before every change:

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

- `npm test` runs the Vitest suite in `tests/`. It covers routes, sessions and
  invites, the budget, provider adapters, the proofreading diff, evaluation
  rules, practice scheduling, the editor reducer and UI states, and the
  extension's capture contract. Provider calls are stubbed, so no key is
  needed.
- Prompt hashes are pinned: `tests/server/proofread-prompt-version.test.ts` and
  `tests/server/evaluation-prompt-version.test.ts` fail when a prompt changes
  without a version bump and a committed corpus run.

## Model-quality runs

`eval/` holds the corpora and runners. Results are committed in
`eval/results/`.

| Runner | Measures |
|---|---|
| `eval/run-proofread.ts` | Planted errors found, false errors, unflagged meaning changes |
| `eval/run-evaluation.ts` | Verdict accuracy, injection resistance, shown versus hidden cue |
| `eval/run-detect-bench.ts` | Sentence-detector precision, recall and latency |
| `eval/run-languagetool-bakeoff.ts` | LanguageTool and Harper against earlier cloud proofreading results on the same corpus |

The runners refuse to make network calls unless you pass `--live`. Paid runs
are held to a spend cap: `--cap-usd` (with a default) for proofreading and
evaluation, and a fixed cap for the detect bench. The bake-off makes no model
calls. For example:

```bash
node --import tsx eval/run-evaluation.ts --live --cap-usd 0.25
```

## Project layout

```text
src/app          Pages and API route handlers
src/features     Client features: editor, practice, speech, expressions, capture
src/server       Server only: auth, budget, db, models, proofread, detect, practice, dictation
src/shared       Request and response contracts (Zod), used by client and server
src/lib          Shared helpers: text normalization, pronunciation
db/migrations    SQLite schema
extension        Optional browser extension (unpacked)
eval             Model-quality corpora, runners and results
tests            Vitest suite
```
