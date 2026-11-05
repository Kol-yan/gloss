# From passive to active: the learning loop

gloss rests on one rule from [ARCHITECTURE.md](../ARCHITECTURE.md): **help is
not knowledge.** Accepting a suggestion shows that you recognise a better
wording. It does not show that you can produce it. gloss counts a word as
yours only when you use it again later, in a new situation, without seeing it
first.

This page walks through that loop and names the code behind each step.

## 1. A suggestion worth learning

You write in the editor (`src/features/editor`). Checking runs in three stages:

| Stage | Where | What it does |
|---|---|---|
| 0 | Browser | The Harper rule checker runs in a WebAssembly worker and marks grammar and punctuation as you type. Its suggestions never leave the device. |
| 1 | `POST /api/detect` | About 800 ms after you stop typing, changed sentences go to the fast-tier detector. A probability of at least 0.5 becomes a badge: *Correction*, *Clarity* or *Word choice*. A badge carries no suggestion. |
| 2 | `POST /api/proofread` | Pressing a badge (one sentence) or **Check with AI** (the whole text) asks the fast tier for corrections and optional improvements. |

Proofreading returns two kinds of output (`src/server/proofread`):

- **Corrections**: each wrong sentence comes back fully corrected, and
  deterministic code diffs it into individual fixes. Fixes that touch numbers,
  names or negation are flagged and never applied by **Fix all safe errors**.
- **Expression suggestions**: at most three per check. Each one is a more
  precise or more natural wording, with a one-line meaning and, for single
  words, American English IPA.

Only a cloud *expression* suggestion that has a meaning can become practice
(`offerFromSuggestion` in `src/features/practice/types.ts`).

## 2. Accepting it is recorded as help

When you apply an expression suggestion, the editor shows **Try using this
yourself** and asks how well you know it: *New to me*, *I know it but don't use
it* or *I use it*. Choosing **Start practice** calls `POST /api/expressions`,
which:

- stores the expression with its meaning and IPA, and the familiarity you chose;
- writes an `assisted_use` evidence event (shown as *Used with help*);
- leaves it due for practice right away.

The familiarity is stored, but nothing reads it yet. It is meant to feed
ranking (see [Planned](#planned)).

## 3. Practise with the expression shown

`/practice` lists the expressions that are due. `POST /api/practice/tasks`
creates a task (`src/server/practice/tasks.ts`):

- The fast tier writes a one- or two-sentence workplace situation in which the
  expression fits naturally (`situation.ts`).
- You answer in writing or by voice.
- The first task for an expression always shows it, with its meaning.

For a voice answer, Muse Voice Transcribe turns the recording into text, and
you confirm or edit the transcript before it is judged. The audio is not
stored. If you change more than 20% of the words, or add the target expression
when the recogniser did not hear it, the attempt is flagged *Transcript edited*
(`isTranscriptEdited` in `text.ts`).

## 4. Judged on the expression, not on everything else

`POST /api/practice/attempts/{attemptId}` sends the situation, the expression,
its meaning and your answer to Muse Spark (`evaluation.ts`). The model does not
give a grade. It reports four facts:

- `task_completed`: the answer responds to the situation;
- `target_used`: the expression itself is used in a sentence. A synonym, a
  paraphrase or quoting the expression does not count;
- `meaning_correct`: it is used with its real meaning;
- `form_correct`: tense, preposition, word order and collocation are right.

Code computes the verdict from three of them (`computeVerdict`):

| Verdict | Rule |
|---|---|
| *Used well* | used, right meaning, right form |
| *Almost* | used, right meaning, wrong form |
| *Not yet* | not used, or used with the wrong meaning |
| *Couldn't check* | the model call failed. The answer is kept and nothing counts for or against you. |

Mistakes elsewhere in the answer do not change the verdict. Text in the answer
that addresses the grader is treated as part of the answer, not obeyed. After
*Almost* or *Not yet* you can try the same task again. Retries add evidence but
do not move the schedule.

## 5. Recall it from memory

Feedback reveals the expression, so gloss waits before it asks you to recall it:

- A new task **hides** the expression when your last evaluated answer for it is
  at least 12 hours old (`HIDDEN_CUE_AFTER_MS` in `recall.ts`). The task card
  shows only the situation, so you have to recall the wording yourself.
- **Need a hint?** shows the first letter and the meaning
  (`Starts with "x…": meaning`). Using it is recorded.
- A hidden situation that leaks the expression is generated once more and then
  replaced by a generic template, so the target is never given away.
- At scoring time an answer counts as *From memory* only if it is the task's
  first attempt and no other answer for the same expression was evaluated in
  the previous 12 hours. This holds even when two tasks were opened at once.

## 6. Spacing

Only the first attempt of a task schedules the next practice
(`submitAttempt` in `attempts.ts`):

| Result | Next practice |
|---|---|
| *Used well*, from memory, no hint | in 3 days |
| anything else | in 1 day |

## What you can see

**My words** (`/expressions`) lists each saved word or expression with its evidence,
newest first: *Used with help*, *Written attempt* or *Spoken attempt* with the
verdict, and the notes *From memory*, *Hint used* and *Transcript edited*. It
also shows when the expression is next due.

The evidence is stored in `evidence_events`, next to `expressions`,
`practice_tasks`, `attempts` and `evaluations` (`db/migrations/0002_practice.sql`).
Every row carries `learner_id`, and every query filters by the signed-in
learner.

## Planned

These parts of the product idea are not in the code yet:

- **Ranking what to practise** by word frequency, personal relevance and
  progress. Today every due expression is listed, newest first. The stored
  familiarity and the evidence history are the intended inputs.
- **An explicit "active" status.** Evidence is recorded and shown, but no rule
  yet declares an expression active.
- **Longer spacing.** The schedule has two steps (1 day or 3 days). It does not
  grow after repeated clean recalls.
