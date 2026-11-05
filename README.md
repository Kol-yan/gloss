# gloss

**Turn the words you know into words you use.**

gloss checks your English writing and picks out wording worth learning. Then it
asks you to use that wording yourself in short practice rounds: first with the
expression in front of you, later from memory.

It is for adult learners at about CEFR B2–C1 (the level the prompts target) who
understand far more English than they use at work.

An open-source English writing and vocabulary practice app.
The hosted demo at gloss.li is free for a limited time: [gloss.li](https://gloss.li).

| Surface | State |
|---|---|
| Web app | Landing page at `/`; editor at `/editor`; no sign-in, with a guest workspace and optional OpenRouter key. |
| Browser extension ([`extension/`](extension/README.md)) | Beta for Chromium, installed unpacked against a gloss server. Firefox is not supported yet. |
| Desktop app ([`desktop/`](desktop/README.md)) | macOS, beta. |

## How a word moves from passive to active

gloss treats an accepted suggestion as help, not knowledge. A word counts as
produced only when you use it again later, without seeing it first.

1. **Write.** The editor checks grammar and punctuation in your browser. After
   a short pause, a fast model flags sentences that need a fix. Open the **AI**
   tab, or press **Check with AI**, to get corrections and up to three
   expression suggestions, each with a one-line meaning.
2. **Accept it and choose to practise.** Accepting an expression offers **Keep
   this expression** in the **Learning** tab. You say how well you know it, and
   it joins your practice list.
3. **Warm up with recognition.** A practice round starts at the rung your
   familiarity earns: choose the meaning, choose the expression that fits a
   meaning, then fill the gap in a sentence.
4. **Recall it from memory.** The last rung shows a situation without the
   expression and asks you to type it. A hint is available, and using it is
   recorded.
5. **Come back.** A correct recall without a hint is what moves a word toward
   active use and schedules its next appearance; other answers bring it back
   sooner.

**My words** shows the evidence for each word or expression: *Used with help*,
written and spoken attempts, *From memory* and *Hint used*. The exact rules are
in [docs/learning-loop.md](docs/learning-loop.md).


## Where the Meta models are used

| Model | Used for | Why |
|---|---|---|
| **Muse Spark 1.3** | Judging practice answers | This is the one judgement that writes to your record: it sets the verdict, the evidence and the next practice date. It must tell real use from a paraphrase, a wrong meaning or "please mark this correct". The model reports four facts and code computes the verdict. |
| **gpt-oss-120b** | Cleaning up dictation | It adds punctuation and drops fillers and restarts, without changing your words, because later checks need your own English. Code rejects any output that contains a word you did not say, and falls back to the raw transcript. |
| **Muse Voice Transcribe 1.0** | Speech-to-text for spoken answers and editor dictation | One batch request per recording (up to 60 s) with an English language bias. The audio is never stored. You confirm the transcript before it is judged. |

Routine text jobs run on a cheaper fast tier: detecting sentences after each
typing pause, proofreading and writing practice situations. By default this is
the open-weight `openai/gpt-oss-120b` via OpenRouter, not a Meta model.

See [evaluation results](eval/README.md) for corpus history.

Details, settings, prices and quotas are in [docs/models.md](docs/models.md).

## Architecture

gloss is one Next.js app with a SQLite database (`node:sqlite`). The same
Docker image runs locally, hosted or self-hosted.

```text
Browser                                   Server (Next.js route handlers)
├─ Editor + Harper rule checker (WASM)    ├─ Guest, invite and visitor-key sessions
│   local suggestions, never uploaded     ├─ Budget: quotas + daily and period caps
├─ Practice: four rungs, typed answers    ├─ Fast tier: detection, proofreading, exercises
├─ Dictation                              ├─ Muse Spark: evaluation; fast tier: dictation clean-up
└─ My words                               ├─ Muse Voice Transcribe: speech-to-text
                                          └─ SQLite
```

- **Local first, cloud on request.** Rule-based checks run in the browser.
  Cloud work happens after a typing pause or when you press a button.
- **The model proposes, code decides.** Models return corrected sentences or
  facts about an answer. Positions, diffs, verdicts and schedules come from
  deterministic code.
- **Every call is paid for in advance.** `reserve()` checks your daily quota
  and the instance's daily and period caps before a call. `settle()` records
  the real cost after it.
- **A free demo for a limited time, plus your own key.** The first visit starts
  a guest workspace with a daily allowance. An invite raises it; add your own
  OpenRouter key in **Settings** to use your key for model calls.

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

In development the first visit starts a guest session automatically. For a
larger allowance, create an invite and open the printed `/join/…` link:

```bash
npm run invite -- --label dev --uses 1 --profile pilot
```

`.env.example` lists the available settings:

`META_API_KEY`, `META_API_BASE_URL`, `META_TEXT_MODEL`, `META_ASR_MODEL`,
`OPENROUTER_API_KEY`, `OPENROUTER_FAST_MODEL`,
`OPENROUTER_FAST_PRICE_IN_PER_M`, `OPENROUTER_FAST_PRICE_OUT_PER_M`,
`BYOK_TRUST_PROXY_HEADERS`, `AI_ENABLED`, `DAILY_BUDGET_USD`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GLOSSY_DATABASE_PATH`,
`GLOSSY_PUBLIC_URL`.

What needs which key:

- No keys: the editor and its local checks.
- `OPENROUTER_API_KEY`: adds sentence flags, proofreading and expression
  suggestions.
- Both keys: adds practice, voice answers and dictation.

More detail is in [docs/development.md](docs/development.md). Docker and
backups are in [SELF_HOSTING.md](SELF_HOSTING.md).

## Browser extension

Until a store listing is available, install the unpacked extension:

1. Open gloss in the same browser to create a guest workspace, or open an invite
   link and press **Continue**.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
3. Choose **Load unpacked** and select the repository's `extension` folder.
4. Open the extension settings, set your gloss server address (default
   `http://localhost:3000`), then choose **Check connection**.

Firefox is not supported yet. See the
[extension installation and setup guide](extension/README.md#install).

## Desktop app

Until a signed download is available, use the macOS build from the
**Desktop app (macOS)** GitHub Actions workflow or build it from source.
Move `gloss.app` to Applications and allow Accessibility and microphone
access when macOS asks. There is no sign-in: on first launch the app creates
its own guest workspace on the server and keeps it.

See the [Mac installation and build guide](desktop/README.md#run-it-on-macos).

## Releases

The website, the browser extension and the desktop app have their own version
numbers and changelogs:

- Website and server: [CHANGELOG.md](CHANGELOG.md), tags `web-v…`
- Browser extension: [extension/CHANGELOG.md](extension/CHANGELOG.md), tags
  `extension-v…`
- Desktop app: [desktop/CHANGELOG.md](desktop/CHANGELOG.md), tags `desktop-v…`

Downloads (the macOS `.dmg` and the extension zip) are attached to
[GitHub Releases](https://github.com/Kol-yan/gloss/releases).

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
