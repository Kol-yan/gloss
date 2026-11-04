-- Adapter progress stays separate from evidence_events, which records actual
-- learner evidence rather than scheduling state.
CREATE TABLE practice_word_progress (
  learner_id           TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  expression_id        TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('learning', 'ready', 'active', 'hidden')),
  next_rung            INTEGER NOT NULL CHECK (next_rung BETWEEN 1 AND 4),
  productive_successes INTEGER NOT NULL DEFAULT 0 CHECK (productive_successes >= 0),
  wrong_streak         INTEGER NOT NULL DEFAULT 0 CHECK (wrong_streak BETWEEN 0 AND 1),
  last_reaction        TEXT CHECK (last_reaction IS NULL OR last_reaction IN ('already_know', 'too_easy', 'not_relevant', 'too_hard')),
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (learner_id, expression_id),
  FOREIGN KEY (expression_id, learner_id)
    REFERENCES expressions (id, learner_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX practice_word_progress_status_idx
  ON practice_word_progress (learner_id, status, updated_at);
