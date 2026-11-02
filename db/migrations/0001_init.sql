-- Stage 1 schema. Money is integer micro-dollars; timestamps are UTC ISO-8601
-- text ("2026-01-31T09:30:00.000Z"), so string comparison orders them.

CREATE TABLE learners (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  quota_profile TEXT NOT NULL CHECK (quota_profile IN ('pilot', 'judge', 'owner')),
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
) STRICT;

-- Only the SHA-256 hash of an invite token is stored.
CREATE TABLE invites (
  token_hash    TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  quota_profile TEXT NOT NULL CHECK (quota_profile IN ('pilot', 'judge', 'owner')),
  max_uses      INTEGER NOT NULL CHECK (max_uses >= 1),
  -- The upper bound makes a double-spent invite a constraint failure.
  uses          INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
  expires_at    TEXT,
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX sessions_learner_idx ON sessions (learner_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Runtime switches, e.g. ai_enabled = 'false'. A missing key means "default".
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- One row per cloud proofreading call. The text itself is never stored, only
-- its hash and length.
CREATE TABLE check_runs (
  id          TEXT PRIMARY KEY,
  learner_id  TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  -- Client idempotency key: a retry with the same id reuses this row.
  request_id  TEXT NOT NULL,
  text_hash   TEXT NOT NULL,
  text_length INTEGER NOT NULL CHECK (text_length >= 0),
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  status      TEXT NOT NULL,
  latency_ms  INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at  TEXT NOT NULL,
  UNIQUE (learner_id, request_id),
  -- Parent key for the composite foreign key in suggestions.
  UNIQUE (id, learner_id)
) STRICT;

CREATE INDEX check_runs_learner_created_idx ON check_runs (learner_id, created_at);

CREATE TABLE suggestions (
  id            TEXT PRIMARY KEY,
  check_run_id  TEXT NOT NULL,
  learner_id    TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  "start"       INTEGER NOT NULL CHECK ("start" >= 0),
  "end"         INTEGER NOT NULL,
  original      TEXT NOT NULL,
  replacement   TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('error', 'style', 'expression')),
  reason        TEXT NOT NULL,
  meaning_change INTEGER NOT NULL DEFAULT 0 CHECK (meaning_change IN (0, 1)),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'rejected', 'stale')),
  decided_at    TEXT,
  CHECK ("end" >= "start"),
  -- A suggestion always belongs to the same learner as its check run.
  FOREIGN KEY (check_run_id, learner_id)
    REFERENCES check_runs (id, learner_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX suggestions_run_idx ON suggestions (check_run_id);
CREATE INDEX suggestions_learner_idx ON suggestions (learner_id, status);

-- Budget ledger. Rows are never deleted by learner removal: they are the
-- record the daily spend ceiling is computed from.
CREATE TABLE usage_reservations (
  id                 TEXT PRIMARY KEY,
  learner_id         TEXT NOT NULL REFERENCES learners (id),
  kind               TEXT NOT NULL CHECK (kind IN ('proofread', 'evaluate', 'asrSeconds')),
  request_id         TEXT NOT NULL,
  units              INTEGER NOT NULL CHECK (units >= 1),
  max_cost_micros    INTEGER NOT NULL CHECK (max_cost_micros >= 0),
  actual_cost_micros INTEGER CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  -- reserved: call pending; settled: actual cost known; unknown: outcome
  -- lost (timeout, dropped connection), so max_cost keeps counting.
  status             TEXT NOT NULL DEFAULT 'reserved'
                     CHECK (status IN ('reserved', 'settled', 'unknown')),
  created_at         TEXT NOT NULL,
  settled_at         TEXT,
  UNIQUE (learner_id, kind, request_id),
  CHECK ((status = 'settled') = (actual_cost_micros IS NOT NULL))
) STRICT;

CREATE INDEX usage_reservations_created_idx ON usage_reservations (created_at);
CREATE INDEX usage_reservations_learner_kind_idx
  ON usage_reservations (learner_id, kind, created_at);
