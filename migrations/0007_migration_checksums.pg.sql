-- Migration 0007: Add checksum tracking to schema_version
ALTER TABLE schema_version ADD COLUMN checksum TEXT;
ALTER TABLE schema_version ADD COLUMN filename TEXT;
