-- Practice: expressions the learner chose to learn, tasks, attempts and the
-- evidence that they produced the expression themselves. Same conventions as
-- 0001: STRICT tables, UTC ISO timestamps, learner_id on every learner-owned
-- row, and composite foreign keys so a child can never point at another
-- learner's parent.

-- One-line meaning of an "expression" suggestion; NULL for other categories.
ALTER TABLE suggestions ADD COLUMN meaning TEXT;

-- Parent key for the composite foreign key from expressions.
CREATE UNIQUE INDEX suggestions_id_learner_idx ON suggestions (id, learner_id);

CREATE TABLE expressions (
  id               TEXT PRIMARY KEY,
  learner_id       TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  suggestion_id    TEXT NOT NULL,
  text             TEXT NOT NULL,
  meaning          TEXT NOT NULL,
  familiarity      TEXT NOT NULL CHECK (familiarity IN ('new', 'known_unused', 'used')),
  -- NULL until the first evaluated attempt schedules the next practice.
  next_practice_at TEXT,
  created_at       TEXT NOT NULL,
  -- One expression per suggestion: creating it again is a no-op.
  UNIQUE (learner_id, suggestion_id),
  UNIQUE (id, learner_id),
  -- No cascade from suggestions: purging old check runs must not silently
  -- erase what the learner chose to practise.
  FOREIGN KEY (suggestion_id, learner_id) REFERENCES suggestions (id, learner_id)
) STRICT;

CREATE INDEX expressions_learner_created_idx ON expressions (learner_id, created_at);

CREATE TABLE practice_tasks (
  id            TEXT PRIMARY KEY,
  learner_id    TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  expression_id TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('written', 'voice')),
  cue           TEXT NOT NULL CHECK (cue IN ('shown', 'hidden')),
  situation     TEXT NOT NULL,
  hint          TEXT NOT NULL,
  -- Client idempotency key: a retry returns the stored task.
  request_id    TEXT NOT NULL,
  -- The model that wrote the situation, or 'template' for the fallback.
  model         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (learner_id, request_id),
  UNIQUE (id, learner_id),
  FOREIGN KEY (expression_id, learner_id)
    REFERENCES expressions (id, learner_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX practice_tasks_expression_idx ON practice_tasks (expression_id);

CREATE TABLE attempts (
  id                  TEXT PRIMARY KEY,
  learner_id          TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL,
  -- Set on a retry of an evaluated attempt; NULL for a task's first attempt.
  previous_attempt_id TEXT,
  status              TEXT NOT NULL DEFAULT 'issued'
                      CHECK (status IN ('issued', 'transcribed', 'evaluating', 'evaluated', 'failed')),
  answer              TEXT,
  answer_hash         TEXT,
  -- Voice attempts: what speech-to-text heard, before the learner confirmed it.
  raw_transcript      TEXT,
  audio_seconds       REAL CHECK (audio_seconds IS NULL OR audio_seconds >= 0),
  transcript_edited   INTEGER NOT NULL DEFAULT 0 CHECK (transcript_edited IN (0, 1)),
  hint_used           INTEGER NOT NULL DEFAULT 0 CHECK (hint_used IN (0, 1)),
  created_at          TEXT NOT NULL,
  evaluated_at        TEXT,
  UNIQUE (id, learner_id),
  FOREIGN KEY (task_id, learner_id)
    REFERENCES practice_tasks (id, learner_id) ON DELETE CASCADE,
  FOREIGN KEY (previous_attempt_id, learner_id)
    REFERENCES attempts (id, learner_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX attempts_task_idx ON attempts (task_id);
CREATE INDEX attempts_previous_idx ON attempts (previous_attempt_id);
CREATE INDEX attempts_learner_status_idx ON attempts (learner_id, status, created_at);

-- Only evaluated attempts have a row; an attempt whose evaluation failed has
-- none and can be submitted again.
CREATE TABLE evaluations (
  attempt_id      TEXT PRIMARY KEY,
  learner_id      TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  verdict         TEXT NOT NULL CHECK (verdict IN ('used_well', 'almost', 'not_yet')),
  task_completed  INTEGER NOT NULL CHECK (task_completed IN (0, 1)),
  target_used     INTEGER NOT NULL CHECK (target_used IN (0, 1)),
  meaning_correct INTEGER NOT NULL CHECK (meaning_correct IN (0, 1)),
  form_correct    INTEGER NOT NULL CHECK (form_correct IN (0, 1)),
  message         TEXT NOT NULL,
  correction      TEXT,
  model           TEXT NOT NULL,
  rubric_version  INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (attempt_id, learner_id)
    REFERENCES attempts (id, learner_id) ON DELETE CASCADE
) STRICT;

-- What the learner has actually done with an expression. Help (an accepted
-- suggestion) is recorded as assisted_use and never counts as production.
CREATE TABLE evidence_events (
  id                TEXT PRIMARY KEY,
  learner_id        TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  expression_id     TEXT NOT NULL,
  attempt_id        TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('assisted_use', 'written_attempt', 'spoken_attempt')),
  verdict           TEXT CHECK (verdict IS NULL OR verdict IN ('used_well', 'almost', 'not_yet')),
  cue               TEXT CHECK (cue IS NULL OR cue IN ('shown', 'hidden')),
  hint_used         INTEGER NOT NULL DEFAULT 0 CHECK (hint_used IN (0, 1)),
  transcript_edited INTEGER NOT NULL DEFAULT 0 CHECK (transcript_edited IN (0, 1)),
  created_at        TEXT NOT NULL,
  FOREIGN KEY (expression_id, learner_id)
    REFERENCES expressions (id, learner_id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id, learner_id)
    REFERENCES attempts (id, learner_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX evidence_events_expression_idx
  ON evidence_events (learner_id, expression_id, created_at);
