-- A reservation can authorize exactly one network request, including after a restart.
ALTER TABLE usage_reservations ADD COLUMN role TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE usage_reservations ADD COLUMN reported_cost_micros INTEGER
  CHECK (reported_cost_micros IS NULL OR reported_cost_micros > 0);
CREATE TABLE budget_dispatches (
  reservation_id TEXT PRIMARY KEY REFERENCES usage_reservations(id),
  dispatched_at TEXT NOT NULL
) STRICT;
