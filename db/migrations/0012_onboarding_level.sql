-- Onboarding: the learner's estimated level and the Word check round.
--
-- `learners.level` keeps the CEFR level estimated from Word check answers (or
-- chosen on the Level step). NULL means "not estimated yet".
--
-- A Word check round is the set of starter entries one learner was served, so
-- the POST can map the ids the page sends back to entry texts. The answer is
-- kept here too: "I use it" words are known vocabulary and never get a
-- `word_progress` row, but their answer still feeds the level estimate and
-- keeps future rounds from asking again. Every row carries `learner_id`;
-- entries are never shared between learners.
CREATE TABLE word_check_entries (
  id            TEXT PRIMARY KEY,
  learner_id    TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  -- Starter entry text. Kept as text so a later edit of the curated set does
  -- not orphan an answer already given.
  text          TEXT NOT NULL,
  level         TEXT NOT NULL CHECK (level IN ('A2', 'B1', 'B2', 'C1')),
  -- The day this learner was last served the word; decides re-asking order.
  last_shown_on TEXT NOT NULL,
  -- The answer given in this round, NULL until it is answered.
  word_check_answer TEXT
                CHECK (word_check_answer IS NULL OR word_check_answer IN
                       ('use', 'know_unused', 'not_sure', 'new')),
  created_at    TEXT NOT NULL,
  UNIQUE (learner_id, id)
) STRICT;

CREATE INDEX word_check_entries_learner_idx ON word_check_entries (learner_id, last_shown_on);

ALTER TABLE learners ADD COLUMN level TEXT
  CHECK (level IS NULL OR level IN ('A2', 'B1', 'B2', 'C1'));

-- The starter level of the entry the word came from, when it has one.
ALTER TABLE word_progress ADD COLUMN level TEXT
  CHECK (level IS NULL OR level IN ('A2', 'B1', 'B2', 'C1'));

-- The Word check entry that created the row, so a later round can tell
-- whether the learner already answered this word.
ALTER TABLE word_progress ADD COLUMN word_check_entry TEXT;
