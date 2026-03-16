import path from "path";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import ignore from "ignore";
import { getPg } from "./pg";
import { loadConfig } from "../config";

export interface ExportOptions {
  redactEmbeddings?: boolean;
  redactCommits?: boolean;
  excludePatterns?: string[];
  repoRoot?: string;
}

const EXPORT_DEFAULTS: Required<Pick<ExportOptions, "redactEmbeddings" | "redactCommits">> = {
  redactEmbeddings: true,
  redactCommits: false,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse a pgvector string representation into a number array.
 * pgvector returns "[1,2,3]" format — we parse it via JSON.
 */
function parseVectorString(s: string): number[] {
  return JSON.parse(s) as number[];
}

/**
 * Build an exclude filter from patterns. Always returns a predicate function
 * (returns `false` for all paths when no patterns are provided).
 */
function buildExcludeFilter(
  excludePatterns: string[],
  indexignorePatterns: string[],
): (filePath: string) => boolean {
  const allPatterns = [...indexignorePatterns, ...excludePatterns];
  if (allPatterns.length === 0) return () => false;

  const ig = ignore();
  ig.add(allPatterns);
  return (filePath: string) => ig.ignores(filePath);
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

async function loadIgnoreFile(filePath: string): Promise<string[]> {
  try {
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const text = await file.text();
      return text.split("\n");
    }
  } catch {
    // ignore missing/unreadable files
  }
  return [];
}

function createExportSchema(
  db: Database,
  redactEmbeddings: boolean,
  redactCommits: boolean,
  dims: number,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id integer PRIMARY KEY, origin_url text, root_path text UNIQUE NOT NULL,
      name text NOT NULL, formatter_cmd text
    );
    CREATE TABLE IF NOT EXISTS files (
      id integer PRIMARY KEY, repo_id int NOT NULL REFERENCES repos(id),
      file_path text NOT NULL, content_hash text NOT NULL, skeleton text,
      skeleton_entries text, file_type text NOT NULL, indexed_at text,
      UNIQUE(repo_id, file_path)
    );
    CREATE TABLE IF NOT EXISTS directories (
      id integer PRIMARY KEY, repo_id int NOT NULL REFERENCES repos(id),
      dir_path text NOT NULL, concat_skeleton text, summary text,
      UNIQUE(repo_id, dir_path)
    );
  `);

  if (!redactEmbeddings) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS file_embeddings USING vec0(
        file_id integer PRIMARY KEY, embedding float[${dims}]
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS dir_concat_embeddings USING vec0(
        dir_id integer PRIMARY KEY, embedding float[${dims}]
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS dir_summary_embeddings USING vec0(
        dir_id integer PRIMARY KEY, embedding float[${dims}]
      );
    `);
  }

  if (!redactCommits) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS commits (
        id integer PRIMARY KEY, repo_id int NOT NULL REFERENCES repos(id),
        commit_hash text NOT NULL, message text NOT NULL, authored_at text,
        UNIQUE(repo_id, commit_hash)
      );
      CREATE TABLE IF NOT EXISTS file_commits (
        file_id int NOT NULL, commit_id int NOT NULL, recency int NOT NULL,
        PRIMARY KEY (file_id, commit_id)
      );
    `);
    if (!redactEmbeddings) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS commit_embeddings USING vec0(
          commit_id integer PRIMARY KEY, embedding float[${dims}]
        );
      `);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg query results are untyped
type PgRow = Record<string, any>;

function exportRepos(db: Database, repos: PgRow[]): void {
  for (const r of repos) {
    db.prepare(
      "INSERT OR REPLACE INTO repos (id, origin_url, root_path, name, formatter_cmd) VALUES (?, ?, ?, ?, ?)",
    ).run(r.id, r.origin_url, r.root_path, r.name, r.formatter_cmd);
  }
}

function exportFiles(
  db: Database,
  files: PgRow[],
  shouldExclude: (filePath: string) => boolean,
  redactEmbeddings: boolean,
): Set<number> {
  const exportedFileIds = new Set<number>();

  for (const f of files) {
    if (shouldExclude(f.file_path)) continue;

    db.prepare(
      "INSERT OR REPLACE INTO files (id, repo_id, file_path, content_hash, skeleton, skeleton_entries, file_type, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      f.id,
      f.repo_id,
      f.file_path,
      f.content_hash,
      f.skeleton,
      f.skeleton_entries ?? null,
      f.file_type,
      f.indexed_at,
    );
    exportedFileIds.add(f.id);

    if (!redactEmbeddings && f.embedding) {
      const vec = parseVectorString(f.embedding);
      db.prepare("INSERT OR REPLACE INTO file_embeddings (file_id, embedding) VALUES (?, ?)").run(
        f.id,
        new Float32Array(vec),
      );
    }
  }

  return exportedFileIds;
}

function exportDirectories(
  db: Database,
  dirs: PgRow[],
  shouldExclude: (filePath: string) => boolean,
  redactEmbeddings: boolean,
): void {
  for (const d of dirs) {
    if (shouldExclude(d.dir_path)) continue;

    db.prepare(
      "INSERT OR REPLACE INTO directories (id, repo_id, dir_path, concat_skeleton, summary) VALUES (?, ?, ?, ?, ?)",
    ).run(d.id, d.repo_id, d.dir_path, d.concat_skeleton, d.summary);

    if (!redactEmbeddings) {
      if (d.concat_embedding) {
        const vec = parseVectorString(d.concat_embedding);
        db.prepare(
          "INSERT OR REPLACE INTO dir_concat_embeddings (dir_id, embedding) VALUES (?, ?)",
        ).run(d.id, new Float32Array(vec));
      }
      if (d.summary_embedding) {
        const vec = parseVectorString(d.summary_embedding);
        db.prepare(
          "INSERT OR REPLACE INTO dir_summary_embeddings (dir_id, embedding) VALUES (?, ?)",
        ).run(d.id, new Float32Array(vec));
      }
    }
  }
}

function exportCommits(db: Database, commits: PgRow[], redactEmbeddings: boolean): void {
  for (const c of commits) {
    db.prepare(
      "INSERT OR REPLACE INTO commits (id, repo_id, commit_hash, message, authored_at) VALUES (?, ?, ?, ?, ?)",
    ).run(c.id, c.repo_id, c.commit_hash, c.message, c.authored_at);
    if (!redactEmbeddings && c.embedding) {
      const vec = parseVectorString(c.embedding);
      db.prepare(
        "INSERT OR REPLACE INTO commit_embeddings (commit_id, embedding) VALUES (?, ?)",
      ).run(c.id, new Float32Array(vec));
    }
  }
}

function exportFileCommits(db: Database, fileCommits: PgRow[], exportedFileIds: Set<number>): void {
  for (const fc of fileCommits) {
    if (exportedFileIds.has(fc.file_id)) {
      db.prepare(
        "INSERT OR REPLACE INTO file_commits (file_id, commit_id, recency) VALUES (?, ?, ?)",
      ).run(fc.file_id, fc.commit_id, fc.recency);
    }
  }
}

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

export async function exportToSqlite(repoId: number, outPath: string, opts: ExportOptions = {}) {
  const redactEmbeddings = opts.redactEmbeddings ?? EXPORT_DEFAULTS.redactEmbeddings;
  const redactCommits = opts.redactCommits ?? EXPORT_DEFAULTS.redactCommits;
  const excludePatterns = opts.excludePatterns ?? [];
  const config = opts.repoRoot ? await loadConfig(opts.repoRoot) : null;
  const dims = config?.embedding?.dimensions ?? 1536;

  // Build exclude filter from .indexignore + explicit patterns
  const indexignorePatterns = opts.repoRoot
    ? await loadIgnoreFile(path.join(opts.repoRoot, ".indexignore"))
    : [];
  const shouldExclude = buildExcludeFilter(excludePatterns, indexignorePatterns);

  const pg = await getPg();
  const db = new Database(outPath);
  db.exec("PRAGMA journal_mode=WAL");

  if (!redactEmbeddings) {
    sqliteVec.load(db);
  }

  createExportSchema(db, redactEmbeddings, redactCommits, dims);

  // Wrap all writes in a transaction for atomicity and performance
  db.exec("BEGIN");
  try {
    // Fetch and export repos
    const repos = await pg.unsafe("SELECT * FROM repos WHERE id = $1", [repoId]);
    exportRepos(db, repos as PgRow[]);

    // Fetch and export files + embeddings
    const fileColumns = redactEmbeddings
      ? "id, repo_id, file_path, content_hash, skeleton, skeleton_entries, file_type, indexed_at::text"
      : "id, repo_id, file_path, content_hash, skeleton, skeleton_entries, file_type, indexed_at::text, embedding::text";
    const files = await pg.unsafe(`SELECT ${fileColumns} FROM files WHERE repo_id = $1`, [repoId]);
    const exportedFileIds = exportFiles(db, files as PgRow[], shouldExclude, redactEmbeddings);

    // Fetch and export directories + embeddings
    const dirColumns = redactEmbeddings
      ? "id, repo_id, dir_path, concat_skeleton, summary"
      : "id, repo_id, dir_path, concat_skeleton, summary, concat_embedding::text, summary_embedding::text";
    const dirs = await pg.unsafe(`SELECT ${dirColumns} FROM directories WHERE repo_id = $1`, [
      repoId,
    ]);
    exportDirectories(db, dirs as PgRow[], shouldExclude, redactEmbeddings);

    // Export commits + embeddings (unless redacted)
    if (!redactCommits) {
      const commitColumns = redactEmbeddings
        ? "id, repo_id, commit_hash, message, authored_at::text"
        : "id, repo_id, commit_hash, message, authored_at::text, embedding::text";
      const commits = await pg.unsafe(`SELECT ${commitColumns} FROM commits WHERE repo_id = $1`, [
        repoId,
      ]);
      exportCommits(db, commits as PgRow[], redactEmbeddings);

      // Export file_commits (only for files that were exported)
      const fileCommits = await pg.unsafe(
        "SELECT fc.file_id, fc.commit_id, fc.recency FROM file_commits fc JOIN files f ON fc.file_id = f.id WHERE f.repo_id = $1",
        [repoId],
      );
      exportFileCommits(db, fileCommits as PgRow[], exportedFileIds);
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  db.close();
}
