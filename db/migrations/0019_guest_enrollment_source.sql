-- Existing enrollments predate source tracking and belong to the web bucket.
ALTER TABLE guest_enrollments ADD COLUMN source TEXT NOT NULL DEFAULT 'web'
  CHECK (source IN ('web', 'desktop'));

CREATE INDEX guest_enrollments_source_created_idx ON guest_enrollments (source, created_at);
CREATE INDEX guest_enrollments_source_ip_created_idx ON guest_enrollments (source, ip_hash, created_at);
