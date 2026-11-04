-- migrate:foreign-keys-off
-- Add the guest quota profile without changing the references on learner-owned rows.
DROP TRIGGER IF EXISTS learners_funding_immutable;
ALTER TABLE learners RENAME TO learners_before_guest_profile;

CREATE TABLE learners (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  quota_profile TEXT NOT NULL CHECK (quota_profile IN ('guest', 'pilot', 'judge', 'owner')),
  created_at    TEXT NOT NULL,
  deleted_at    TEXT,
  funding_source TEXT NOT NULL DEFAULT 'hosted'
                  CHECK (funding_source IN ('hosted', 'byok')),
  level         TEXT CHECK (level IS NULL OR level IN ('A2', 'B1', 'B2', 'C1'))
) STRICT;

INSERT INTO learners (id, display_name, quota_profile, created_at, deleted_at, funding_source, level)
SELECT id, display_name, quota_profile, created_at, deleted_at, funding_source, level
FROM learners_before_guest_profile;

DROP TABLE learners_before_guest_profile;

CREATE TRIGGER learners_funding_immutable
BEFORE UPDATE OF funding_source ON learners
WHEN NEW.funding_source != OLD.funding_source
  AND NOT (OLD.funding_source = 'hosted' AND NEW.funding_source = 'byok')
BEGIN
  SELECT RAISE(ABORT, 'Learner funding cannot change');
END;

CREATE TABLE guest_enrollments (
  id         TEXT PRIMARY KEY,
  ip_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX guest_enrollments_ip_created_idx
  ON guest_enrollments (ip_hash, created_at);

CREATE TABLE invite_redemptions (
  token_hash  TEXT NOT NULL REFERENCES invites (token_hash) ON DELETE CASCADE,
  learner_id  TEXT NOT NULL REFERENCES learners (id) ON DELETE CASCADE,
  redeemed_at TEXT NOT NULL,
  PRIMARY KEY (token_hash, learner_id)
) STRICT;

CREATE INDEX invite_redemptions_learner_idx ON invite_redemptions (learner_id, redeemed_at);
