# gloss

**Turn the words you know into words you use.**

gloss checks your English writing and picks out wording worth learning. Then it
asks you to use that wording yourself, in writing or out loud: first with the
expression in front of you, later from memory.

It is for adult learners at about CEFR B2–C1 (the level the prompts target) who
understand far more English than they use at work.

Built for the Meta Global AI Developer Hackathon. Status: working prototype.

| Surface | State |
|---|---|
| Web app | Works. The test bench for everything below: editor, practice, expression history. |
| Browser extension ([`extension/`](extension/README.md)) | Source and automated checks only. It opens selected text in the editor. Manual installation in a browser has not been verified. |
| Desktop app | Planned. There is no code for it yet. |

## How a word moves from passive to active

gloss treats an accepted suggestion as help, not knowledge. A word counts as
produced only when you use it again later, without seeing it first.

1. **Write.** The editor checks grammar and punctuation in your browser. After
   a short pause, a fast model flags sentences that need a fix. Press a flag, or
   **Check with AI**, to get corrections and up to three expression suggestions,
   each with a one-line meaning.
2. **Accept it and choose to practise.** Accepting an expression offers **Try
   using this yourself**. You say how well you know it, and it joins your list
   as *used with help*.
3. **Use it with the cue shown.** A practice task gives a short workplace
   situation and the expression. You answer in a sentence or two, typed or
   spoken.
4. **Get judged on the expression only.** Muse Spark reports whether you used
   the expression, with the right meaning and in the right form. Code turns that
   into *Used well*, *Almost* or *Not yet*. Mistakes elsewhere in the answer do
   not count against you, and a failed check counts for nothing.
5. **Recall it from memory.** Once your last feedback on the expression is at
   least 12 hours old, the next task hides it and shows only the situation. A
   hint is available, and using it is recorded.
6. **Come back.** After a clean recall (hidden, no hint, *Used well*), the next
   practice is in 3 days. Otherwise it is due again after one day.

**My expressions** shows the evidence for each expression: *Used with help*,
written and spoken attempts, *From memory*, *Hint used* and *Transcript edited*.
The exact rules are in [docs/learning-loop.md](docs/learning-loop.md).

**Planned:**

- Ranking practice by word frequency, personal relevance and progress. Today
  all due expressions are listed, newest first. The familiarity you choose is
  stored but not used yet.
- An explicit "active" status derived from the evidence.

## Where the Meta models are used

| Model | Used for | Why |
|---|---|---|
| **Muse Spark 1.3** | Judging practice answers | This is the one judgement that writes to your record: it sets the verdict, the evidence and the next practice date. It must tell real use from a paraphrase, a wrong meaning or "please mark this correct". The model reports four facts and code computes the verdict. |
| **Muse Spark 1.3** | Cleaning up dictation | It adds punctuation and drops fillers and restarts, without changing your words, because later checks need your own English. Code rejects any output that contains a word you did not say, and falls back to the raw transcript. |
| **Muse Voice Transcribe 1.0** | Speech-to-text for spoken answers and editor dictation | One batch request per recording (up to 60 s) with an English language bias. The audio is never stored. You confirm the transcript before it is judged. |

Routine text jobs run on a cheaper fast tier: detecting sentences after each
typing pause, proofreading and writing practice situations. By default this is
the open-weight `openai/gpt-oss-120b` via OpenRouter, not a Meta model.

In the committed evaluation run
([`eval/results/2026-11-03-evaluation-v4.md`](eval/results/2026-11-03-evaluation-v4.md)),
Muse Spark gave an acceptable verdict on all 48 rows (24 answers, each judged
with the cue shown and hidden) and passed none of the 18 injection or
wrong-meaning rows.

Details, settings, prices and quotas are in [docs/models.md](docs/models.md).

## Architecture

gloss is one Next.js app with a SQLite database (`node:sqlite`). The same
Docker image runs locally, hosted or self-hosted.

```text
Browser                                   Server (Next.js route handlers)
├─ Editor + Harper rule checker (WASM)    ├─ Invite-only sessions, visitor keys
│   local suggestions, never uploaded     ├─ Budget: quotas + daily spend ceiling
├─ Practice: writing and voice            ├─ Fast tier: detection, proofreading, situations
├─ Dictation                              ├─ Muse Spark: answer evaluation, dictation clean-up
└─ My expressions                         ├─ Muse Voice Transcribe: speech-to-text
                                          └─ SQLite
```

- **Local first, cloud on request.** Rule-based checks run in the browser.
  Cloud work happens after a typing pause or when you press a button.
- **The model proposes, code decides.** Models return corrected sentences or
  facts about an answer. Positions, diffs, verdicts and schedules come from
  deterministic code.
- **Every call is paid for in advance.** `reserve()` checks your daily quota
  and the instance's daily ceiling before a call. `settle()` records the real
  cost after it.
- **No anonymous cloud access.** You need an invite, or a workspace funded by
  your own OpenRouter key.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the data model, API, budget and
identity rules.

## Run it locally

You need Node 26.

```bash
npm ci
```

```bash
cp .env.example .env.local
```

```bash
npm run dev
```

```bash
npm run invite -- --label me --uses 1 --profile owner
```

Open the printed `/join/…` link and press **Continue**.

`.env.example` lists the variables:

- Meta: `META_API_KEY`, `META_API_BASE_URL`, `META_TEXT_MODEL`,
  `META_ASR_MODEL`
- OpenRouter fast tier: `OPENROUTER_API_KEY`, `OPENROUTER_FAST_MODEL`,
  `OPENROUTER_FAST_PRICE_IN_PER_M`, `OPENROUTER_FAST_PRICE_OUT_PER_M`
- Limits: `AI_ENABLED`, `DAILY_BUDGET_USD`, `BYOK_TRUST_PROXY_HEADERS`
- App: `GLOSSY_DATABASE_PATH`, `GLOSSY_PUBLIC_URL`

What needs which key:

- No keys: the editor and its local checks.
- `OPENROUTER_API_KEY`: adds sentence flags, proofreading and expression
  suggestions.
- Both keys: adds practice, voice answers and dictation.

More detail is in [docs/development.md](docs/development.md). Docker and
backups are in [SELF_HOSTING.md](SELF_HOSTING.md).

## Tests and checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

- End-to-end smoke tests drive headless Chromium against a production build, a
  fresh temporary database and simulated model providers (`GLOSSY_MODEL_MOCK`),
  so they need no keys and never call a provider. Install the browser once with
  `npx playwright install chromium`, then run `npm run test:e2e`.

- `npm test` runs the Vitest suite in `tests/` with provider calls stubbed, so
  it needs no keys.
- The proofreading and evaluation prompts are pinned by hash. Changing one
  fails the tests until a new corpus run is committed to `eval/results/`.
- The corpus runners in `eval/` call models only with `--live`, and only up to
  a spend cap.

## Licence

gloss is licensed under [AGPL-3.0-only](LICENSE). If you run a modified
version for other people over a network, you must offer them its source.

Third-party packages keep their own licences. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The models are reached over
their providers' APIs under those providers' terms. No model weights are
included.
