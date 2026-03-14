-- Migration 0007: Add migration checksum tracking for SQLite
CREATE TABLE IF NOT EXISTS migration_checksums (
  version INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
