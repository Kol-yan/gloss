ALTER TABLE check_runs ADD COLUMN serving_provider TEXT;
ALTER TABLE check_runs ADD COLUMN settled_cost_micros INTEGER
  CHECK (settled_cost_micros IS NULL OR settled_cost_micros >= 0);
