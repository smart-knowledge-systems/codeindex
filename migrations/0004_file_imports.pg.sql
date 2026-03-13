-- Structured import graph: tracks import/export edges between files.

CREATE TABLE IF NOT EXISTS file_imports (
  id              serial PRIMARY KEY,
  source_file_id  int NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  imported_module text NOT NULL,
  resolved_file_id int REFERENCES files(id) ON DELETE SET NULL,
  language        text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_imports_source ON file_imports(source_file_id);
CREATE INDEX IF NOT EXISTS idx_file_imports_resolved ON file_imports(resolved_file_id);

INSERT INTO schema_version (version) VALUES (4);
