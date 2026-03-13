-- Add children_hash column for directory summary caching.
-- When children haven't changed, skip Haiku re-summarization.

ALTER TABLE directories ADD COLUMN children_hash text;
