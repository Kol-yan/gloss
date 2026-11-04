-- Independent real writing is a separate observation, never a scored attempt.
CREATE TABLE evidence_events_new (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  expression_id TEXT NOT NULL,
  attempt_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('assisted_use', 'written_attempt', 'spoken_attempt', 'independent_writing')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('used_well', 'almost', 'not_yet')),
  cue TEXT CHECK (cue IS NULL OR cue IN ('shown', 'hidden')),
  hint_used INTEGER NOT NULL DEFAULT 0 CHECK (hint_used IN (0, 1)),
  transcript_edited INTEGER NOT NULL DEFAULT 0 CHECK (transcript_edited IN (0, 1)),
  created_at TEXT NOT NULL,
  document_id TEXT,
  FOREIGN KEY (expression_id, learner_id) REFERENCES expressions (id, learner_id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id, learner_id) REFERENCES attempts (id, learner_id) ON DELETE CASCADE,
  CHECK (kind != 'independent_writing' OR (attempt_id IS NULL AND verdict IS NULL AND cue IS NULL AND document_id IS NOT NULL))
) STRICT;

INSERT INTO evidence_events_new
  (id, learner_id, expression_id, attempt_id, kind, verdict, cue, hint_used, transcript_edited, created_at)
SELECT id, learner_id, expression_id, attempt_id, kind, verdict, cue, hint_used, transcript_edited, created_at
FROM evidence_events;
DROP TABLE evidence_events;
ALTER TABLE evidence_events_new RENAME TO evidence_events;
CREATE INDEX evidence_events_expression_idx ON evidence_events (learner_id, expression_id, created_at);
CREATE UNIQUE INDEX independent_writing_document_idx
  ON evidence_events (learner_id, expression_id, document_id) WHERE kind = 'independent_writing';

-- Distinguish the list-aware operation from unbiased proofreading, while
-- reusing its suggestion storage and decision/Undo contracts.
ALTER TABLE check_runs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'proofread'
  CHECK (purpose IN ('proofread', 'learning'));
