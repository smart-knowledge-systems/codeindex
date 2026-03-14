-- RLS on join tables
ALTER TABLE file_commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE cross_repo_edges ENABLE ROW LEVEL SECURITY;

-- file_commits: check file exists in scope
CREATE POLICY repo_scope_file_commits ON file_commits
  USING (file_id IN (SELECT id FROM files));

-- file_imports: check source file exists in scope
CREATE POLICY repo_scope_file_imports ON file_imports
  USING (source_file_id IN (SELECT id FROM files));

-- cross_repo_edges: both source and target must be in scope
CREATE POLICY repo_scope_cross_repo_edges ON cross_repo_edges
  USING (
    source_repo_id = ANY(current_setting('app.current_repo_ids', true)::int[])
    AND target_repo_id = ANY(current_setting('app.current_repo_ids', true)::int[])
  );

ALTER TABLE file_commits FORCE ROW LEVEL SECURITY;
ALTER TABLE file_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE cross_repo_edges FORCE ROW LEVEL SECURITY;

INSERT INTO schema_version (version, checksum, filename) VALUES (9, '', '0009_rls_phase2.pg.sql');
