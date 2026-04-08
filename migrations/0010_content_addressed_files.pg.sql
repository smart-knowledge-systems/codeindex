-- Phase 3 dedup: content-addressed file storage.
-- Introduces file_blobs (one row per unique content+embedding-config) and the
-- repo_files junction (per-repo path -> blob). The legacy `files` table stays
-- in place during the dual-write period; it will be dropped in a follow-up PR.
--
-- No RLS on these tables: scoping for the junction search path is enforced
-- via WHERE clauses on repo_files.repo_id, not via row-level policies. RLS on
-- file_blobs / repo_files is a cidx-cloud concern and lives outside this repo.

CREATE TABLE IF NOT EXISTS file_blobs (
  content_hash      text NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,
  dimensions        int  NOT NULL,
  skeleton          text,
  skeleton_entries  jsonb,
  file_type         text,
  embedding         vector(1536),
  created_at        timestamptz DEFAULT now(),
  PRIMARY KEY (content_hash, provider, model, dimensions)
);

CREATE INDEX IF NOT EXISTS idx_file_blobs_embedding_hnsw
  ON file_blobs USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS repo_files (
  repo_id       int  NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  file_path     text NOT NULL,
  content_hash  text NOT NULL,
  provider      text NOT NULL,
  model         text NOT NULL,
  dimensions    int  NOT NULL,
  indexed_at    timestamptz DEFAULT now(),
  PRIMARY KEY (repo_id, file_path),
  FOREIGN KEY (content_hash, provider, model, dimensions)
    REFERENCES file_blobs (content_hash, provider, model, dimensions)
);

CREATE INDEX IF NOT EXISTS idx_repo_files_blob
  ON repo_files (content_hash, provider, model, dimensions);

CREATE INDEX IF NOT EXISTS idx_repo_files_repo
  ON repo_files (repo_id);
