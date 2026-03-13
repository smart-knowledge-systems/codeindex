-- Application-level access tokens for repo-scoped visibility on shared PG.

CREATE TABLE IF NOT EXISTS access_tokens (
  id            serial PRIMARY KEY,
  token_hash    text NOT NULL UNIQUE,
  name          text NOT NULL,
  created_at    timestamptz DEFAULT now(),
  expires_at    timestamptz,
  revoked       boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS token_repo_access (
  token_id      int NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
  repo_id       int NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  PRIMARY KEY (token_id, repo_id)
);

INSERT INTO schema_version (version) VALUES (5);
