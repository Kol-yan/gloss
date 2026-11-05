# Evaluation history

These corpus runs record model quality at the time they were executed. Results
are historical measurements, not a guarantee for other models, prompts or
inputs. Full methods and case-level details remain in each run report.

## Practice answer evaluation

| Run | Model | Rows | Acceptable verdicts | Injection or wrong-meaning passes | Cue disagreements | p50 / p95 latency | Accounted cost |
|---|---|---:|---:|---:|---:|---:|---:|
| [evaluation-v4](results/2026-11-03-evaluation-v4.md), 2026-11-03 | Muse Spark 1.3 | 48 | 48/48 | 0/18 | 0/24 pairs | 4.949 / 8.570 s | $0.184535 |

## Proofreading

| Run | Model | Planted errors found | False errors | Meaning changes unflagged | Calls | p50 / p95 latency | Accounted cost |
|---|---|---:|---:|---:|---:|---:|---:|
| [proofread-v9](results/2026-11-03-proofread-v9.md), 2026-11-03 | gpt-oss-120b preset | 28/29 | 0 | 0 | 40 | 3.076 / 6.431 s | $0.003536 |

## Other recorded runs

- [Proofreading iterations](results/): v1–v8 document earlier prompt and model
  results, including runs that did not meet their acceptance criteria.
- [Sentence detection benchmark](results/2026-11-03-detect-bench.md): candidate
  precision, recall, latency and cost evidence.
- [LanguageTool bake-off](results/2026-11-03-languagetool-bakeoff.md): comparison
  on the proofreading corpus.

Run reports preserve the original measurements and assumptions. The runners in
this directory make live model calls only when explicitly passed `--live` and
apply their configured spend cap.
