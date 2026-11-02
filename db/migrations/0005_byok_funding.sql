-- Funding is separate from daily quota profiles. Existing learners stay hosted.
ALTER TABLE learners ADD COLUMN funding_source TEXT NOT NULL DEFAULT 'hosted'
  CHECK (funding_source IN ('hosted', 'byok'));
ALTER TABLE usage_reservations ADD COLUMN funding_source TEXT NOT NULL DEFAULT 'hosted'
  CHECK (funding_source IN ('hosted', 'byok'));

CREATE TRIGGER learners_funding_immutable
BEFORE UPDATE OF funding_source ON learners
WHEN NEW.funding_source != OLD.funding_source
BEGIN
  SELECT RAISE(ABORT, 'Learner funding cannot change');
END;

CREATE TRIGGER reservations_funding_immutable
BEFORE UPDATE OF funding_source ON usage_reservations
WHEN NEW.funding_source != OLD.funding_source
BEGIN
  SELECT RAISE(ABORT, 'Reservation funding cannot change');
END;
