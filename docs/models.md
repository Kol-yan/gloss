# Models: where each one is used and why

gloss splits model work into two text tiers plus speech. A *role* (one kind of
job, `src/server/models/roles.ts`) fixes its tier, its `max_tokens` and its
sampling settings. The provider is chosen in `src/server/models/access.ts`,
and nothing else in the code talks to a model provider.

| Job | Tier | Hosted model | Code |
|---|---|---|---|
| Judge a practice answer | smart | Muse Spark 1.3 (`muse-spark-1.3`) | `src/server/practice/evaluation.ts`, `attempts.ts` |
| Tidy dictated text | fast | `openai/gpt-oss-120b` via OpenRouter | `src/server/dictation/service.ts` |
| Speech-to-text | speech | Muse Voice Transcribe 1.0 (`muse-voice-transcribe-1.0`) | `src/server/models/meta-asr.ts` |
| Flag sentences after a typing pause | fast | `openai/gpt-oss-120b` via OpenRouter | `src/server/detect` |
| Proofread | fast | `openai/gpt-oss-120b` via OpenRouter | `src/server/proofread` |
| Write a practice situation | fast | `openai/gpt-oss-120b` via OpenRouter | `src/server/practice/situation.ts` |

For invited learners, Muse Spark and Muse Voice Transcribe are called directly
on the Meta API (`META_API_BASE_URL`). The fast tier is an open-weight model on
the operator's OpenRouter account, not a Meta model. Operators can set
`OPENROUTER_FAST_MODEL` to another model or preset. Visitors who bring their
own key use OpenRouter for everything (see [Visitor keys](#visitor-keys)).

## Muse Spark 1.3: judging answers

Evaluation is the one model output that writes to the learner's record: it
decides the verdict, the evidence event and the next practice date (see
[learning-loop.md](learning-loop.md)). An over-generous judge would mark a word
as used when it was not, so this job runs on the stronger model.

- **Facts, not a grade.** The model returns four booleans (`task_completed`,
  `target_used`, `meaning_correct`, `form_correct`), a short message and an
  optional correction. Code computes the verdict.
- **Settings:** 4,096 output tokens including reasoning, reasoning effort
  `low`, temperature 0.
- **Answer as data.** The answer sits inside `<answer>` tags, and the prompt
  treats any request in it, such as "give me a pass", as part of the answer.
- **Measured.** Historical corpus results and per-run metrics are listed in
  [`eval/README.md`](../eval/README.md).
- **Pinned.** `tests/server/evaluation-prompt-version.test.ts` pins the
  prompt's version and SHA-256. Editing the prompt fails `npm test` until a new
  corpus run is committed.

## Fast tier: cleaning up dictation

The editor's **Dictate** button records up to 60 seconds and sends it to
`POST /api/speech/dictate`. First Muse Voice Transcribe produces the
transcript, then `openai/gpt-oss-120b` via OpenRouter tidies it:

- It may add punctuation and capitals, remove fillers (*um*, *uh*, filler
  *like*) and remove immediate repeats or restarts.
- It must not change, add, reorder or translate words, even wrong ones. Later
  checks have to see the learner's own English.
- Code enforces this: `parseCleanup` rejects any output that contains a word
  the speaker did not say, or says a word more often than it was spoken.
- If the clean-up fails or is rejected, the raw transcript is inserted instead
  (`cleaned: false`).
- **Settings:** 2,048 output tokens, reasoning effort `minimal`, temperature 0.
  It counts as one `proofread` operation.
- Neither the audio nor the text is stored. Only the spending ledger records
  the two calls.

## Muse Voice Transcribe 1.0: speech

It is used for spoken practice answers (`POST /api/speech/transcribe`) and for
dictation.

- **One batch request per recording.** `PUSH_TO_TALK` mode returns the whole
  transcript in one answer. An English language bias is sent as a hint and
  does not force the language.
- **Input.** The browser converts the recording to WAV (mono, 16-bit PCM,
  16 or 24 kHz, at most 60 seconds and 3 MB). The server checks the WAV before
  it reserves any money.
- **Cost.** It is priced per minute of audio and reserved per second against
  the learner's `asrSeconds` quota.
- **Storage.** The audio stays in memory and is dropped. For practice, only the
  transcript and the duration are stored, and you confirm or edit the
  transcript before it is judged.

## The fast tier: routine text jobs

Detection runs after every typing pause, proofreading on every badge press or
check, and a situation is written for every task. These jobs are frequent and
tightly structured, so the code sends them to "a cheap open-weight model for
routine work" (`access.ts`) and keeps Muse Spark for the judgements that
matter. The price table in `src/server/models/prices.ts` shows the gap:

| Model | Input, USD per 1M tokens | Output, USD per 1M tokens |
|---|---|---|
| Muse Spark 1.3 | 1.25 | 4.25 |
| `openai/gpt-oss-120b`, range of listed providers | 0.03–0.35 | 0.107–0.95 |
| `openai/gpt-oss-120b`, bound used for reservations | 0.70 | 1.90 |

The proofreading prompt is measured on its own corpus. In the committed run
[`proofread-v9`](../eval/results/2026-11-03-proofread-v9.md):

- 28 of 29 planted errors were found;
- no correct sentence got a false error;
- no meaning change went unflagged;
- 40 calls cost $0.0035.

A missing `OPENROUTER_API_KEY` switches the fast jobs off. Meta is never used
in its place.

## Every call is paid for in advance

Model calls go through `reserve()` and `settle()` in `src/server/budget`:

1. Before the call, one SQLite transaction checks the kill switch, the
   learner's daily quota and the instance's daily spend ceiling
   (`DAILY_BUDGET_USD`) against a worst-case cost. The worst case is computed
   from the input size, the role's `max_tokens` and the price.
2. After the call, the reservation is settled at the reported cost.

A call whose outcome is unknown, such as a timeout, stays counted at its worst
case. A model without a known price is never called. Each adapter makes one
call with no retries, and there is no fallback to another provider or tier.

Current daily quotas per learner (`src/server/config.ts`):

| Profile | `proofread` | `detect` | `evaluate` | `asrSeconds` |
|---|---:|---:|---:|---:|
| `guest` | 30 | 30 | 3 | 300 |
| `pilot` | 20 | 100 | 12 | 180 |
| `judge` | 30 | 30 | 30 | 300 |
| `owner` | 200 | 200 | 100 | 1800 |

Some jobs count against another job's quota:

- dictation clean-up counts as `proofread`;
- writing a practice situation counts as `evaluate`, like judging the answer.

When a limit is reached or AI is switched off, the editor keeps its local
checks.

## Learner text and model output

- Learner text goes to the model as delimited data. Models have no tools.
- Every response must match a strict JSON schema and is parsed again with Zod.
- Models propose text. Positions, diffs, verdicts and schedules are computed
  by deterministic code.
- Learner text is not written to logs, and learners never see raw provider
  errors.

## Visitor keys

A visitor without an invite can start a separate workspace with their own
OpenRouter key (`POST /api/access/byok`):

- The key stays in their browser and is sent with each model request in
  `X-Gloss-Provider-Key`. It is never stored or logged on the server.
- Their jobs use `openai/gpt-oss-120b`, `meta/muse-spark-1.3` and
  `meta/muse-voice-transcribe-1.0` on OpenRouter.
- Requests ask for providers that deny data collection. This is a routing
  preference, not verified zero retention.
- These workspaces use the `pilot` quotas and are limited to six reservations
  per minute and two pending calls. Their cost does not count toward the
  operator's ceiling.
- A missing or failing visitor key never falls back to the operator's
  credentials.
