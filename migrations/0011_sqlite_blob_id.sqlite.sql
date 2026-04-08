-- Phase 3 dedup: add an integer surrogate primary key to file_blobs so the
-- companion sqlite-vec virtual table (file_blob_embeddings, created at
-- runtime in src/db/migrate.ts) can key on a single integer rowid. vec0
-- virtual tables don't support composite keys, so the (content_hash,
-- provider, model, dimensions) PK from 0010 can't be used directly.
--
-- Recreating the table is safe: 0010 only just landed on
-- feat/dependency-dedup-phase2 and dual-write is best-effort, so any rows
-- already in file_blobs locally will be repopulated on the next reindex.

DROP INDEX IF EXISTS idx_repo_files_blob;
DROP INDEX IF EXISTS idx_repo_files_repo;
DROP TABLE IF EXISTS repo_files;
DROP TABLE IF EXISTS file_blobs;

CREATE TABLE file_blobs (
  blob_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash      text NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,
  dimensions        int  NOT NULL,
  skeleton          text,
  skeleton_entries  text,
  file_type         text,
  created_at        text DEFAULT (datetime('now')),
  UNIQUE (content_hash, provider, model, dimensions)
);

CREATE TABLE repo_files (
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

CREATE INDEX idx_repo_files_blob
  ON repo_files (content_hash, provider, model, dimensions);

CREATE INDEX idx_repo_files_repo
  ON repo_files (repo_id);
