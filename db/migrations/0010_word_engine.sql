-- The word engine: per-learner state for every word practice can rank.
--
-- A row exists for a saved expression, a starter entry the learner has met and
-- a Word check word that is kept as known vocabulary. `expression_id` is the
-- saved expression id for a saved word and an engine-issued id otherwise.
-- `normalized` is the lower-case, single-spaced text used to join the two.
-- Nothing here is shared between learners: the starter text lives in code and
-- only this learner's row is stored.
CREATE TABLE word_progress (
  expression_id        TEXT PRIMARY KEY,
  learner_id           TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  text                 TEXT NOT NULL,
  normalized           TEXT NOT NULL,
  source               TEXT NOT NULL
                       CHECK (source IN ('saved', 'starter', 'word_check', 'added')),
  status               TEXT NOT NULL CHECK (status IN ('learning', 'ready', 'active', 'hidden')),
  -- Curated band for a starter entry; for other words the documented estimate.
  -- NULL while a stored band is unknown; the engine then estimates.
  band                 TEXT CHECK (band IS NULL OR band IN ('core', 'common', 'uncommon', 'rare')),
  -- Ladder position: 1 recognise, 2 choose by meaning, 3 fill the gap,
  -- 4 recall from memory, 5 use it in a situation, 6 said aloud.
  rung                 INTEGER NOT NULL DEFAULT 1 CHECK (rung BETWEEN 1 AND 6),
  -- Successful productive answers (rung 2 and above) while the word is known.
  productive_answers   INTEGER NOT NULL DEFAULT 0 CHECK (productive_answers >= 0),
  -- Unassisted uses recorded from the learner's own writing.
  real_use_count       INTEGER NOT NULL DEFAULT 0 CHECK (real_use_count >= 0),
  -- Errors since the last correct answer; two in a row move the word down.
  consecutive_errors   INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  answers              INTEGER NOT NULL DEFAULT 0 CHECK (answers >= 0),
  correct_answers      INTEGER NOT NULL DEFAULT 0 CHECK (correct_answers >= 0),
  -- Word check "not sure" answers: a word the learner half-knows.
  deep_known           INTEGER NOT NULL DEFAULT 0 CHECK (deep_known >= 0),
  -- "too easy" reactions: a word that is ready early.
  bland                INTEGER NOT NULL DEFAULT 0 CHECK (bland >= 0),
  -- The day a brand-new word was first introduced, for the daily cap.
  introduced_on        TEXT,
  last_practiced_at    TEXT,
  next_at              TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (learner_id, normalized)
) STRICT;

CREATE INDEX word_progress_learner_status_idx ON word_progress (learner_id, status);
CREATE INDEX word_progress_learner_next_idx ON word_progress (learner_id, next_at);

-- Every practice answer, kept for the failure streak and the "Too hard" fade.
-- A reaction is stored on the answer that carried it.
CREATE TABLE word_practice_events (
  id            TEXT PRIMARY KEY,
  learner_id    TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  expression_id TEXT NOT NULL,
  rung          INTEGER NOT NULL CHECK (rung BETWEEN 1 AND 6),
  productive    INTEGER NOT NULL CHECK (productive IN (0, 1)),
  correct       INTEGER NOT NULL CHECK (correct IN (0, 1)),
  used_hint     INTEGER NOT NULL CHECK (used_hint IN (0, 1)),
  reaction      TEXT CHECK (reaction IS NULL OR reaction IN
                 ('already_know', 'too_easy', 'not_relevant', 'too_hard')),
  created_at    TEXT NOT NULL,
  FOREIGN KEY (expression_id, learner_id)
    REFERENCES word_progress (expression_id, learner_id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX word_progress_expression_learner_idx
  ON word_progress (expression_id, learner_id);
CREATE INDEX word_practice_events_word_idx
  ON word_practice_events (learner_id, expression_id, created_at);
