-- Cross-repo relationship discovery: tracks import edges that span repos.

CREATE TABLE IF NOT EXISTS cross_repo_edges (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_repo_id  INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  target_repo_id  INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source_file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  imported_module TEXT NOT NULL,
  target_file_id  INTEGER REFERENCES files(id) ON DELETE SET NULL,
  language        TEXT NOT NULL,
  discovered_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cross_repo_edges_source ON cross_repo_edges(source_repo_id);
CREATE INDEX IF NOT EXISTS idx_cross_repo_edges_target ON cross_repo_edges(target_repo_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_repo_edges_unique
  ON cross_repo_edges(source_file_id, imported_module);
