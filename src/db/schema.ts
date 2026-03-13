import { getPg } from "./pg";
import { getSqlite } from "./sqlite";

export async function ensurePgSchema() {
  const pg = await getPg();

  await pg.unsafe("CREATE EXTENSION IF NOT EXISTS vector");

  await pg.unsafe(`
    CREATE TABLE IF NOT EXISTS repos (
      id            serial PRIMARY KEY,
      origin_url    text,
      root_path     text UNIQUE NOT NULL,
      name          text NOT NULL,
      formatter_cmd text
    )
  `);

  await pg.unsafe(`
    CREATE TABLE IF NOT EXISTS files (
      id            serial PRIMARY KEY,
      repo_id       int NOT NULL REFERENCES repos(id),
      file_path     text NOT NULL,
      content_hash  text NOT NULL,
      skeleton      text,
      file_type     text NOT NULL,
      embedding     vector(1536),
      indexed_at    timestamptz DEFAULT now(),
      UNIQUE(repo_id, file_path)
    )
  `);

  await pg.unsafe(`
    CREATE TABLE IF NOT EXISTS directories (
      id                  serial PRIMARY KEY,
      repo_id             int NOT NULL REFERENCES repos(id),
      dir_path            text NOT NULL,
      concat_skeleton     text,
      concat_embedding    vector(1536),
      summary             text,
      summary_embedding   vector(1536),
      UNIQUE(repo_id, dir_path)
    )
  `);

  await pg.unsafe(`
    CREATE TABLE IF NOT EXISTS commits (
      id            serial PRIMARY KEY,
      repo_id       int NOT NULL REFERENCES repos(id),
      commit_hash   text NOT NULL,
      message       text NOT NULL,
      embedding     vector(1536),
      authored_at   timestamptz,
      UNIQUE(repo_id, commit_hash)
    )
  `);

  await pg.unsafe(`
    CREATE TABLE IF NOT EXISTS file_commits (
      file_id       int NOT NULL REFERENCES files(id),
      commit_id     int NOT NULL REFERENCES commits(id),
      recency       int NOT NULL,
      PRIMARY KEY (file_id, commit_id)
    )
  `);
}

export async function ensureSqliteSchema(repoRoot?: string) {
  const db = await getSqlite(repoRoot);

  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id            integer PRIMARY KEY AUTOINCREMENT,
      origin_url    text,
      root_path     text UNIQUE NOT NULL,
      name          text NOT NULL,
      formatter_cmd text
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id            integer PRIMARY KEY AUTOINCREMENT,
      repo_id       int NOT NULL REFERENCES repos(id),
      file_path     text NOT NULL,
      content_hash  text NOT NULL,
      skeleton      text,
      file_type     text NOT NULL,
      indexed_at    text DEFAULT (datetime('now')),
      UNIQUE(repo_id, file_path)
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS file_embeddings USING vec0(
      file_id integer PRIMARY KEY,
      embedding float[1536]
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS directories (
      id                  integer PRIMARY KEY AUTOINCREMENT,
      repo_id             int NOT NULL REFERENCES repos(id),
      dir_path            text NOT NULL,
      concat_skeleton     text,
      summary             text,
      UNIQUE(repo_id, dir_path)
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS dir_concat_embeddings USING vec0(
      dir_id integer PRIMARY KEY,
      embedding float[1536]
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS dir_summary_embeddings USING vec0(
      dir_id integer PRIMARY KEY,
      embedding float[1536]
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS commits (
      id            integer PRIMARY KEY AUTOINCREMENT,
      repo_id       int NOT NULL REFERENCES repos(id),
      commit_hash   text NOT NULL,
      message       text NOT NULL,
      authored_at   text,
      UNIQUE(repo_id, commit_hash)
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS commit_embeddings USING vec0(
      commit_id integer PRIMARY KEY,
      embedding float[1536]
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS file_commits (
      file_id       int NOT NULL REFERENCES files(id),
      commit_id     int NOT NULL REFERENCES commits(id),
      recency       int NOT NULL,
      PRIMARY KEY (file_id, commit_id)
    )
  `);
}
