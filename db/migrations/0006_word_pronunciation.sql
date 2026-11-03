-- Pronunciation comes from the same budgeted proofreading response, never an
-- extra enrichment call. Existing items keep an explicit unknown value.
ALTER TABLE suggestions ADD COLUMN ipa TEXT
  CHECK (ipa IS NULL OR (length(ipa) BETWEEN 3 AND 98 AND substr(ipa, 1, 1) = '/' AND substr(ipa, -1, 1) = '/'));
ALTER TABLE expressions ADD COLUMN ipa TEXT
  CHECK (ipa IS NULL OR (length(ipa) BETWEEN 3 AND 98 AND substr(ipa, 1, 1) = '/' AND substr(ipa, -1, 1) = '/'));
