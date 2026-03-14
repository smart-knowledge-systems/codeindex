-- Application-level access tokens for repo-scoped visibility.

CREATE TABLE IF NOT EXISTS access_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash    TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now')),
  expires_at    TEXT,
  revoked       INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS token_repo_access (
  token_id      INTEGER NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  PRIMARY KEY (token_id, repo_id)
);

INSERT INTO schema_version (version) VALUES (5);
