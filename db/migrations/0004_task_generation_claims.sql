-- One durable claim per logical task request prevents parallel retries from
-- paying for the same generation. The owner token fences a stale worker after
-- another process has reclaimed its request.
CREATE TABLE practice_task_requests (
  learner_id    TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  request_id    TEXT NOT NULL,
  expression_id TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('written', 'voice')),
  generation_id TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'completed')),
  started_at    TEXT NOT NULL,
  PRIMARY KEY (learner_id, request_id),
  FOREIGN KEY (expression_id, learner_id)
    REFERENCES expressions (id, learner_id) ON DELETE CASCADE
) STRICT;
