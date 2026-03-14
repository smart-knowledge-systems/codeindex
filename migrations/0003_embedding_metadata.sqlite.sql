-- Track embedding provider and dimensions per repo to detect mixed-provider indexes.

ALTER TABLE repos ADD COLUMN embedding_provider text;
ALTER TABLE repos ADD COLUMN embedding_dimensions int;
