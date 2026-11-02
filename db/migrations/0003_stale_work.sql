-- Work that was started and never finished (the process died mid-call) must
-- not block the learner for ever. These two additions let the server tell
-- "still running" from "abandoned".

-- When the attempt entered 'evaluating'. An evaluation older than two minutes
-- is treated as failed on the next request.
ALTER TABLE attempts ADD COLUMN evaluating_since TEXT;

-- Open reservations are few and old ones are swept to 'unknown' on every new
-- reservation; this index keeps that sweep from scanning the whole ledger.
CREATE INDEX usage_reservations_open_idx ON usage_reservations (created_at) WHERE status = 'reserved';
