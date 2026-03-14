-- Baseline schema for SQLite (sqlite-vec)
-- This captures the schema as of M2 completion.
-- Note: vec0 virtual tables are created by application code, not SQL migrations,
-- because they require the sqlite-vec extension to be loaded first.

CREATE TABLE IF NOT EXISTS repos (
  id            integer PRIMARY KEY AUTOINCREMENT,
  origin_url    text,
  root_path     text UNIQUE NOT NULL,
  name          text NOT NULL,
  formatter_cmd text
);

CREATE TABLE IF NOT EXISTS files (
  id                integer PRIMARY KEY AUTOINCREMENT,
  repo_id           int NOT NULL REFERENCES repos(id),
  file_path         text NOT NULL,
  content_hash      text NOT NULL,
  skeleton          text,
  skeleton_entries  text,
  file_type         text NOT NULL,
  indexed_at        text DEFAULT (datetime('now')),
  UNIQUE(repo_id, file_path)
);

CREATE TABLE IF NOT EXISTS directories (
  id                  integer PRIMARY KEY AUTOINCREMENT,
  repo_id             int NOT NULL REFERENCES repos(id),
  dir_path            text NOT NULL,
  concat_skeleton     text,
  summary             text,
  UNIQUE(repo_id, dir_path)
);

CREATE TABLE IF NOT EXISTS commits (
  id            integer PRIMARY KEY AUTOINCREMENT,
  repo_id       int NOT NULL REFERENCES repos(id),
  commit_hash   text NOT NULL,
  message       text NOT NULL,
  authored_at   text,
  UNIQUE(repo_id, commit_hash)
);

CREATE TABLE IF NOT EXISTS file_commits (
  file_id       int NOT NULL REFERENCES files(id),
  commit_id     int NOT NULL REFERENCES commits(id),
  recency       int NOT NULL,
  PRIMARY KEY (file_id, commit_id)
);

CREATE TABLE IF NOT EXISTS cost_events (
  id            integer PRIMARY KEY AUTOINCREMENT,
  repo_id       int NOT NULL REFERENCES repos(id),
  operation     text NOT NULL,
  model         text NOT NULL,
  tokens_in     int NOT NULL DEFAULT 0,
  tokens_out    int NOT NULL DEFAULT 0,
  cost_usd      real NOT NULL DEFAULT 0,
  created_at    text DEFAULT (datetime('now'))
);

-- SQLite schema version is tracked via PRAGMA user_version (set by migrate.ts)
