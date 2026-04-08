-- Phase 3 dedup: content-addressed file storage (SQLite).
-- Scalar tables only. The vec0 virtual table for blob-level vector search is
-- created at runtime in app code (same pattern as file_embeddings) because
-- vec0 requires the sqlite-vec extension to be loaded first.

CREATE TABLE IF NOT EXISTS file_blobs (
  content_hash      text NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,
  dimensions        int  NOT NULL,
  skeleton          text,
  skeleton_entries  text,
  file_type         text,
  created_at        text DEFAULT (datetime('now')),
  PRIMARY KEY (content_hash, provider, model, dimensions)
);

CREATE TABLE IF NOT EXISTS repo_files (
  repo_id       int  NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  file_path     text NOT NULL,
  content_hash  text NOT NULL,
  provider      text NOT NULL,
  model         text NOT NULL,
  dimensions    int  NOT NULL,
  indexed_at    text DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, file_path),
  FOREIGN KEY (content_hash, provider, model, dimensions)
    REFERENCES file_blobs (content_hash, provider, model, dimensions)
);

CREATE INDEX IF NOT EXISTS idx_repo_files_blob
  ON repo_files (content_hash, provider, model, dimensions);

CREATE INDEX IF NOT EXISTS idx_repo_files_repo
  ON repo_files (repo_id);
