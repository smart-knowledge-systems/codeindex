-- Cross-repo relationship discovery: tracks import edges that span repos.

CREATE TABLE IF NOT EXISTS cross_repo_edges (
  id              serial PRIMARY KEY,
  source_repo_id  int NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  target_repo_id  int NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source_file_id  int NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  imported_module text NOT NULL,
  target_file_id  int REFERENCES files(id) ON DELETE SET NULL,
  language        text NOT NULL,
  discovered_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cross_repo_edges_source ON cross_repo_edges(source_repo_id);
CREATE INDEX IF NOT EXISTS idx_cross_repo_edges_target ON cross_repo_edges(target_repo_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_repo_edges_unique
  ON cross_repo_edges(source_file_id, imported_module);

INSERT INTO schema_version (version) VALUES (6);
