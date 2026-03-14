-- RLS on join tables
ALTER TABLE file_commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE cross_repo_edges ENABLE ROW LEVEL SECURITY;

-- file_commits: check file's repo is in scope via direct repo_id lookup
-- Uses a non-RLS-gated subquery (repo_id on join table) to avoid O(n) nested
-- policy evaluations when the files table itself is RLS-gated.
CREATE POLICY repo_scope_file_commits ON file_commits
  USING (EXISTS (
    SELECT 1 FROM files f
    WHERE f.id = file_commits.file_id
      AND f.repo_id = ANY(current_setting('app.current_repo_ids', true)::int[])
  ));

-- file_imports: check source file's repo is in scope via direct repo_id lookup
CREATE POLICY repo_scope_file_imports ON file_imports
  USING (EXISTS (
    SELECT 1 FROM files f
    WHERE f.id = file_imports.source_file_id
      AND f.repo_id = ANY(current_setting('app.current_repo_ids', true)::int[])
  ));

-- cross_repo_edges: at least one side (source or target) must be in scope
-- Using OR because cross-repo edges always connect two different repos;
-- AND would make single-repo tokens always receive empty results.
CREATE POLICY repo_scope_cross_repo_edges ON cross_repo_edges
  USING (
    source_repo_id = ANY(current_setting('app.current_repo_ids', true)::int[])
    OR target_repo_id = ANY(current_setting('app.current_repo_ids', true)::int[])
  );

ALTER TABLE file_commits FORCE ROW LEVEL SECURITY;
ALTER TABLE file_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE cross_repo_edges FORCE ROW LEVEL SECURITY;

