-- Global dedup store (Phase 1): file-level + package-level embedding cache.
-- Lives alongside per-repo tables in the same Postgres instance, but is
-- versioned independently via the global_schema_version table.

CREATE TABLE IF NOT EXISTS global_schema_version (
  version     int PRIMARY KEY,
  checksum    text,
  filename    text,
  applied_at  timestamptz DEFAULT now()
);

-- File-level cache. Source of truth for deduplicated embeddings.
-- Keyed by content hash + embedding config so different providers/models
-- never collide.
CREATE TABLE IF NOT EXISTS content_blobs (
  content_hash      text NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,
  dimensions        int  NOT NULL,
  skeleton          text,
  skeleton_entries  jsonb,
  embedding         vector(1536),
  ref_count         int  NOT NULL DEFAULT 1,
  created_at        timestamptz DEFAULT now(),
  PRIMARY KEY (content_hash, provider, model, dimensions)
);

-- Package-level tree-hash cache. A tree hash hit means the entire package
-- can be skipped without descending into it.
CREATE TABLE IF NOT EXISTS packages (
  id            serial PRIMARY KEY,
  ecosystem     text NOT NULL,
  name          text NOT NULL,
  version       text NOT NULL,
  tree_hash     text NOT NULL,
  provider      text NOT NULL,
  model         text NOT NULL,
  dimensions    int  NOT NULL,
  indexed_at    timestamptz DEFAULT now(),
  UNIQUE (tree_hash, provider, model, dimensions)
);

CREATE INDEX IF NOT EXISTS packages_name_version_idx
  ON packages (ecosystem, name, version);

-- Thin join: each package consists of N files, each file references a
-- content_blobs row by content_hash. Cross-version dedup falls out of this
-- naturally — two package versions share rows for unchanged files.
CREATE TABLE IF NOT EXISTS package_files (
  package_id    int  NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  relpath       text NOT NULL,
  content_hash  text NOT NULL,
  PRIMARY KEY (package_id, relpath)
);

-- Refcount tracking: which repos consume which packages. Used by future GC.
CREATE TABLE IF NOT EXISTS repo_packages (
  repo_root     text NOT NULL,
  package_id    int  NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  mount_path    text NOT NULL,
  PRIMARY KEY (repo_root, package_id, mount_path)
);
