-- Global dedup store (Phase 1) — SQLite dialect.
-- Lives at ~/.codeindex/global.db (or config.dedup.sqlitePath).
-- Versioned via PRAGMA user_version on its own DB handle.
--
-- Embedding column is NOT in this table — sqlite-vec requires a vec0 virtual
-- table, which is created at runtime in ensureGlobalSqliteVecTables() because
-- the dimension count comes from config.

CREATE TABLE IF NOT EXISTS content_blobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash      text NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,
  dimensions        int  NOT NULL,
  skeleton          text,
  skeleton_entries  text,
  ref_count         int  NOT NULL DEFAULT 1,
  created_at        text DEFAULT (datetime('now')),
  UNIQUE (content_hash, provider, model, dimensions)
);

CREATE INDEX IF NOT EXISTS content_blobs_hash_idx
  ON content_blobs (content_hash);

CREATE TABLE IF NOT EXISTS packages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ecosystem     text NOT NULL,
  name          text NOT NULL,
  version       text NOT NULL,
  tree_hash     text NOT NULL,
  provider      text NOT NULL,
  model         text NOT NULL,
  dimensions    int  NOT NULL,
  indexed_at    text DEFAULT (datetime('now')),
  UNIQUE (tree_hash, provider, model, dimensions)
);

CREATE INDEX IF NOT EXISTS packages_name_version_idx
  ON packages (ecosystem, name, version);

CREATE TABLE IF NOT EXISTS package_files (
  package_id    int  NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  relpath       text NOT NULL,
  content_hash  text NOT NULL,
  PRIMARY KEY (package_id, relpath)
);

CREATE TABLE IF NOT EXISTS repo_packages (
  repo_root     text NOT NULL,
  package_id    int  NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  mount_path    text NOT NULL,
  PRIMARY KEY (repo_root, package_id, mount_path)
);
