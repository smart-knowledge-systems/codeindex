-- Enable RLS on core tables
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE directories ENABLE ROW LEVEL SECURITY;
ALTER TABLE commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_events ENABLE ROW LEVEL SECURITY;

-- Create policies using session-level repo scope
CREATE POLICY repo_scope_files ON files
  USING (repo_id = ANY(current_setting('app.current_repo_ids', true)::int[]));

CREATE POLICY repo_scope_directories ON directories
  USING (repo_id = ANY(current_setting('app.current_repo_ids', true)::int[]));

CREATE POLICY repo_scope_commits ON commits
  USING (repo_id = ANY(current_setting('app.current_repo_ids', true)::int[]));

CREATE POLICY repo_scope_cost_events ON cost_events
  USING (repo_id = ANY(current_setting('app.current_repo_ids', true)::int[]));

-- Admin role bypasses RLS
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'codeindex_admin') THEN
    CREATE ROLE codeindex_admin;
  END IF;
END $$;

ALTER TABLE files FORCE ROW LEVEL SECURITY;
ALTER TABLE directories FORCE ROW LEVEL SECURITY;
ALTER TABLE commits FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_events FORCE ROW LEVEL SECURITY;

-- Grant bypass to admin
ALTER ROLE codeindex_admin BYPASSRLS;

