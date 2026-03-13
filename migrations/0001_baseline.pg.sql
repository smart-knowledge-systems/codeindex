-- Baseline schema for PostgreSQL (pgvector)
-- This captures the schema as of M2 completion.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS repos (
  id            serial PRIMARY KEY,
  origin_url    text,
  root_path     text UNIQUE NOT NULL,
  name          text NOT NULL,
  formatter_cmd text
);

CREATE TABLE IF NOT EXISTS files (
  id                serial PRIMARY KEY,
  repo_id           int NOT NULL REFERENCES repos(id),
  file_path         text NOT NULL,
  content_hash      text NOT NULL,
  skeleton          text,
  skeleton_entries  jsonb,
  file_type         text NOT NULL,
  embedding         vector(1536),
  indexed_at        timestamptz DEFAULT now(),
  UNIQUE(repo_id, file_path)
);

CREATE TABLE IF NOT EXISTS directories (
  id                  serial PRIMARY KEY,
  repo_id             int NOT NULL REFERENCES repos(id),
  dir_path            text NOT NULL,
  concat_skeleton     text,
  concat_embedding    vector(1536),
  summary             text,
  summary_embedding   vector(1536),
  UNIQUE(repo_id, dir_path)
);

CREATE TABLE IF NOT EXISTS commits (
  id            serial PRIMARY KEY,
  repo_id       int NOT NULL REFERENCES repos(id),
  commit_hash   text NOT NULL,
  message       text NOT NULL,
  embedding     vector(1536),
  authored_at   timestamptz,
  UNIQUE(repo_id, commit_hash)
);

CREATE TABLE IF NOT EXISTS file_commits (
  file_id       int NOT NULL REFERENCES files(id),
  commit_id     int NOT NULL REFERENCES commits(id),
  recency       int NOT NULL,
  PRIMARY KEY (file_id, commit_id)
);

CREATE TABLE IF NOT EXISTS cost_events (
  id            serial PRIMARY KEY,
  repo_id       int NOT NULL REFERENCES repos(id),
  operation     text NOT NULL,
  model         text NOT NULL,
  tokens_in     int NOT NULL DEFAULT 0,
  tokens_out    int NOT NULL DEFAULT 0,
  cost_usd      double precision NOT NULL DEFAULT 0,
  created_at    timestamptz DEFAULT now()
);

-- HNSW vector indexes for fast approximate nearest-neighbor search
CREATE INDEX IF NOT EXISTS idx_files_embedding_hnsw
  ON files USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_dirs_concat_embedding_hnsw
  ON directories USING hnsw (concat_embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_dirs_summary_embedding_hnsw
  ON directories USING hnsw (summary_embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_commits_embedding_hnsw
  ON commits USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version     int NOT NULL,
  applied_at  timestamptz DEFAULT now()
);

INSERT INTO schema_version (version) VALUES (1);
