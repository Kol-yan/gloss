-- Real use from the learner's own writing, read from Learning-tab evidence.
--
-- `real_use_documents` and `real_use_days` mirror the distinct documents and
-- days found in `evidence_events` for the word (`kind = 'independent_writing'`).
-- They let the engine advance a word once per new document even when the same
-- document is reported more than once. `real_use_last_at` is set by an explicit
-- real-use record so a second record on the same day does not add a day.
-- `word_check_answer` keeps the Word check answer behind a word that entered
-- through Word check; it decides whether the word is brand new.
ALTER TABLE word_progress ADD COLUMN real_use_documents INTEGER NOT NULL DEFAULT 0
  CHECK (real_use_documents >= 0);
ALTER TABLE word_progress ADD COLUMN real_use_days INTEGER NOT NULL DEFAULT 0
  CHECK (real_use_days >= 0);
ALTER TABLE word_progress ADD COLUMN real_use_last_at TEXT;
ALTER TABLE word_progress ADD COLUMN word_check_answer TEXT
  CHECK (word_check_answer IS NULL OR word_check_answer IN
         ('use', 'know_unused', 'not_sure', 'new'));
