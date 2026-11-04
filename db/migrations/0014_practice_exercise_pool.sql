-- Generated exercises are cached per learner and expression. The history is
-- separate so bounded cache eviction cannot remove the seven-day exclusion.
CREATE TABLE practice_exercise_pool (
  id            TEXT PRIMARY KEY,
  learner_id    TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  expression_id TEXT NOT NULL,
  rung          INTEGER NOT NULL CHECK (rung BETWEEN 1 AND 4),
  sentence      TEXT NOT NULL,
  sentence_hash TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  options_json  TEXT,
  answer        TEXT NOT NULL,
  hint          TEXT NOT NULL,
  example       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (learner_id, expression_id, sentence_hash),
  FOREIGN KEY (expression_id, learner_id)
    REFERENCES word_progress (expression_id, learner_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX practice_exercise_pool_lookup_idx
  ON practice_exercise_pool (learner_id, expression_id, rung, created_at);

CREATE TABLE practice_exercise_history (
  id            TEXT PRIMARY KEY,
  learner_id    TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  expression_id TEXT NOT NULL,
  rung          INTEGER NOT NULL CHECK (rung BETWEEN 1 AND 4),
  sentence_hash TEXT NOT NULL,
  sentence      TEXT NOT NULL,
  used_at       TEXT NOT NULL,
  FOREIGN KEY (expression_id, learner_id)
    REFERENCES word_progress (expression_id, learner_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX practice_exercise_history_lookup_idx
  ON practice_exercise_history (learner_id, expression_id, used_at, sentence_hash);

CREATE TABLE practice_exercise_generation_leases (
  learner_id    TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  expression_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  PRIMARY KEY (learner_id, expression_id),
  FOREIGN KEY (expression_id, learner_id)
    REFERENCES word_progress (expression_id, learner_id) ON DELETE CASCADE
) STRICT;
