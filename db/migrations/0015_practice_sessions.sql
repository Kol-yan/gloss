-- Durable, request-scoped practice sessions. Every row is learner-owned and
-- composite foreign keys prevent cross-learner references.
CREATE TABLE practice_sessions (
  id          TEXT PRIMARY KEY,
  learner_id  TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  request_id  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'failed', 'finished', 'empty')),
  requested_size INTEGER NOT NULL CHECK (requested_size BETWEEN 1 AND 8),
  total       INTEGER NOT NULL CHECK (total BETWEEN 0 AND 8),
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  summary_json TEXT,
  UNIQUE (learner_id, request_id),
  UNIQUE (id, learner_id)
) STRICT;

CREATE INDEX practice_sessions_learner_created_idx
  ON practice_sessions (learner_id, created_at DESC);

CREATE TABLE practice_session_items (
  id                TEXT PRIMARY KEY,
  learner_id        TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  session_id        TEXT NOT NULL,
  ordinal           INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  expression_id     TEXT NOT NULL,
  word_text         TEXT NOT NULL,
  meaning           TEXT NOT NULL,
  ipa               TEXT,
  slot              TEXT NOT NULL CHECK (slot IN ('activate', 'learn', 'keep')),
  word_status       TEXT NOT NULL CHECK (word_status IN ('learning', 'ready', 'active', 'hidden')),
  start_rung        INTEGER NOT NULL CHECK (start_rung BETWEEN 1 AND 6),
  frequency         TEXT NOT NULL CHECK (frequency IN ('core', 'common', 'uncommon', 'rare')),
  why               TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'generating', 'ready', 'issued', 'answered', 'failed')),
  generation_id     TEXT,
  generation_started_at TEXT,
  exercise_json     TEXT,
  issued_at         TEXT,
  hint_used         INTEGER NOT NULL DEFAULT 0 CHECK (hint_used IN (0, 1)),
  submitted_answer  TEXT,
  answer_hash       TEXT,
  answer_correct    INTEGER CHECK (answer_correct IS NULL OR answer_correct IN (0, 1)),
  dont_know         INTEGER NOT NULL DEFAULT 0 CHECK (dont_know IN (0, 1)),
  answer_json       TEXT,
  reaction          TEXT CHECK (reaction IS NULL OR reaction IN ('already_know', 'too_easy', 'not_relevant', 'too_hard')),
  answered_at       TEXT,
  UNIQUE (session_id, ordinal),
  UNIQUE (id, learner_id),
  FOREIGN KEY (session_id, learner_id)
    REFERENCES practice_sessions (id, learner_id) ON DELETE CASCADE,
  FOREIGN KEY (expression_id, learner_id)
    REFERENCES word_progress (expression_id, learner_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX practice_session_items_order_idx
  ON practice_session_items (learner_id, session_id, ordinal);
CREATE INDEX practice_session_items_expression_idx
  ON practice_session_items (learner_id, expression_id, answered_at);
