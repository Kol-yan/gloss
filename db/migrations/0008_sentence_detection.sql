-- Add a separate detector ledger without storing learner sentence text.
CREATE TABLE detect_runs (
  id                  TEXT PRIMARY KEY,
  learner_id          TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  request_id          TEXT NOT NULL,
  fingerprint         TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'failed', 'unknown')),
  serving_provider    TEXT,
  latency_ms          INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  settled_cost_micros INTEGER CHECK (settled_cost_micros IS NULL OR settled_cost_micros >= 0),
  response_json       TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (learner_id, request_id),
  CHECK ((status = 'ok') = (response_json IS NOT NULL))
) STRICT;

CREATE INDEX detect_runs_learner_created_idx ON detect_runs (learner_id, created_at);

-- SQLite cannot alter the existing kind CHECK in place. Rebuild the ledger and
-- copy every column so historical reservations and their audit evidence remain.
CREATE TABLE usage_reservations_new (
  id                 TEXT PRIMARY KEY,
  learner_id         TEXT NOT NULL REFERENCES learners (id),
  kind               TEXT NOT NULL CHECK (kind IN ('proofread', 'detect', 'evaluate', 'asrSeconds')),
  request_id         TEXT NOT NULL,
  units              INTEGER NOT NULL CHECK (units >= 1),
  max_cost_micros    INTEGER NOT NULL CHECK (max_cost_micros >= 0),
  actual_cost_micros INTEGER CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  status             TEXT NOT NULL DEFAULT 'reserved'
                     CHECK (status IN ('reserved', 'settled', 'unknown')),
  created_at         TEXT NOT NULL,
  settled_at         TEXT,
  funding_source     TEXT NOT NULL DEFAULT 'hosted'
                     CHECK (funding_source IN ('hosted', 'byok')),
  UNIQUE (learner_id, kind, request_id),
  CHECK ((status = 'settled') = (actual_cost_micros IS NOT NULL))
) STRICT;

INSERT INTO usage_reservations_new
  (id, learner_id, kind, request_id, units, max_cost_micros, actual_cost_micros,
   status, created_at, settled_at, funding_source)
SELECT id, learner_id, kind, request_id, units, max_cost_micros, actual_cost_micros,
       status, created_at, settled_at, funding_source
FROM usage_reservations;

DROP TABLE usage_reservations;
ALTER TABLE usage_reservations_new RENAME TO usage_reservations;

CREATE INDEX usage_reservations_created_idx ON usage_reservations (created_at);
CREATE INDEX usage_reservations_learner_kind_idx
  ON usage_reservations (learner_id, kind, created_at);
CREATE INDEX usage_reservations_open_idx
  ON usage_reservations (created_at) WHERE status = 'reserved';

CREATE TRIGGER reservations_funding_immutable
BEFORE UPDATE OF funding_source ON usage_reservations
WHEN NEW.funding_source != OLD.funding_source
BEGIN
  SELECT RAISE(ABORT, 'Reservation funding cannot change');
END;
