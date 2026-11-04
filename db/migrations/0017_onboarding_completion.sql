-- A learner stays past the first-visit onboarding gate after completing it.
ALTER TABLE learners ADD COLUMN onboarding_completed_at TEXT;
