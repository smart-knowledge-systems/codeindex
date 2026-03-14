-- Track embedding provider and dimensions per repo to detect mixed-provider indexes.

ALTER TABLE repos ADD COLUMN IF NOT EXISTS embedding_provider text;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS embedding_dimensions int;
