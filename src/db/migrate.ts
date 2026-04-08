import { createHash } from "crypto";
import { readdir, readFile } from "fs/promises";
import path from "path";
import type { Database } from "bun:sqlite";
import { getPg } from "./pg";
import { getSqlite } from "./sqlite";
import { logEvent } from "../logging";
import { loadConfig } from "../config";

const MIGRATIONS_DIR = path.join(import.meta.dir, "../../migrations");
const GLOBAL_MIGRATIONS_DIR = path.join(import.meta.dir, "../../migrations/global");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MigrationFile {
  version: number;
  filename: string;
  sql: string;
}

export type MigrationResult = { tag: "ok"; versions: number[] } | { tag: "err"; error: Error };

export type ChecksumVerification =
  | { tag: "ok"; valid: boolean; mismatches: string[] }
  | { tag: "unavailable" };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex digest of a string. */
function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Parse SQL into individual statements by splitting on semicolons. */
function parseSqlStatements(sql: string): string[] {
  return sql.split(";").map((s) => s.trim());
}

/** Remove comment-only lines from SQL statements. */
function stripCommentLines(statements: string[]): string[] {
  return statements
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

/**
 * Strip a trailing SQL inline comment (`-- ...`) from a line, but only if the
 * `--` is not inside a string literal.  Walks the line character-by-character
 * toggling an in-string flag on unescaped single quotes.
 */
function stripInlineComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inString) {
      inString = true;
    } else if (ch === "'" && inString) {
      // Two consecutive quotes ('') are an escaped quote inside a literal
      if (i + 1 < line.length && line[i + 1] === "'") {
        i++; // skip the escaped quote
      } else {
        inString = false;
      }
    } else if (!inString && ch === "-" && i + 1 < line.length && line[i + 1] === "-") {
      // Found an unquoted `--` — trim from here
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

/**
 * Split SQL into statements, preserving dollar-quoted blocks (DO $$ ... $$;).
 * Strips comment-only lines and empty statements.
 */
function splitPgStatements(sql: string): string[] {
  const results: string[] = [];
  let current = "";
  let dollarTag: string | null = null; // null = outside, string = the tag we're inside

  const lines = sql.split("\n");
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!dollarTag && trimmed.startsWith("--")) continue;

    // Strip trailing inline comments (string-literal-aware) outside dollar-quoted blocks
    const effectiveLine = !dollarTag ? stripInlineComment(line) : line;
    current += (current ? "\n" : "") + effectiveLine;

    // Toggle dollar-quoting state (supports both $$ and tagged variants like $body$)
    const dollarRe = /\$([A-Za-z_]*)\$/g;
    let m: RegExpExecArray | null;
    while ((m = dollarRe.exec(line)) !== null) {
      const tag = m[0]; // e.g. "$$" or "$body$"
      if (dollarTag === null) {
        dollarTag = tag; // entering a dollar-quoted block
      } else if (dollarTag === tag) {
        dollarTag = null; // closing the matching tag
      }
    }
    const inDollarQuote = dollarTag !== null;
    if (!inDollarQuote && effectiveLine.trimEnd().endsWith(";")) {
      const stmt = current.replace(/;$/, "").trim();
      if (stmt.length > 0) results.push(stmt);
      current = "";
    }
  }

  // Capture any trailing statement without semicolon
  const remaining = current.trim();
  if (remaining.length > 0) results.push(remaining);

  return results;
}

// ---------------------------------------------------------------------------
// I/O boundary — file loading
// ---------------------------------------------------------------------------

/**
 * Read and sort migration files for the given backend.
 * Files must match the pattern: NNNN_description.{pg,sqlite}.sql
 */
async function loadMigrationFiles(backend: "pg" | "sqlite"): Promise<MigrationFile[]> {
  return loadMigrationsFromDir(MIGRATIONS_DIR, backend);
}

async function loadMigrationsFromDir(
  dir: string,
  backend: "pg" | "sqlite",
): Promise<MigrationFile[]> {
  const suffix = `.${backend}.sql`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const migrations: MigrationFile[] = [];
  for (const filename of entries) {
    if (!filename.endsWith(suffix)) continue;
    const versionStr = filename.split("_")[0];
    const version = parseInt(versionStr, 10);
    if (isNaN(version)) continue;

    const sql = await readFile(path.join(dir, filename), "utf-8");
    migrations.push({ version, filename, sql });
  }

  return migrations.sort((a, b) => a.version - b.version);
}

// ---------------------------------------------------------------------------
// I/O boundary — PostgreSQL
// ---------------------------------------------------------------------------

async function getPgVersion(): Promise<number> {
  const pg = await getPg();
  try {
    const rows = await pg.unsafe(
      "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
    );
    return rows.length > 0 ? (rows[0].version as number) : 0;
  } catch {
    // Table doesn't exist yet — version 0
    return 0;
  }
}

async function applyPgMigrations(): Promise<MigrationResult> {
  const pg = await getPg();
  const currentVersion = await getPgVersion();
  const migrations = await loadMigrationFiles("pg");
  const applied: number[] = [];

  for (const m of migrations) {
    if (m.version <= currentVersion) continue;

    // Run each migration in a connection-pinned transaction
    try {
      await pg.begin(async (tx) => {
        // Split on semicolons, preserving dollar-quoted blocks (DO $$ ... $$;)
        const statements = splitPgStatements(m.sql);

        for (const stmt of statements) {
          await tx.unsafe(stmt);
        }

        // Update version — checksum/filename columns added in migration 7
        if (m.version > 1) {
          if (m.version >= 7) {
            await tx.unsafe(
              "INSERT INTO schema_version (version, checksum, filename) VALUES ($1, $2, $3)",
              [m.version, sha256(m.sql), m.filename],
            );
          } else {
            await tx.unsafe("INSERT INTO schema_version (version) VALUES ($1)", [m.version]);
          }
        }
      });
      applied.push(m.version);
      logEvent({ event: "infra.migrate.apply", version: m.version, backend: "pg" });
    } catch (err) {
      return {
        tag: "err",
        error: new Error(`Migration ${m.version} failed: ${err}`, { cause: err }),
      };
    }
  }

  // Backfill checksums for pre-v7 migrations on PG
  const finalVersion = await getPgVersion();
  if (finalVersion >= 7) {
    for (const m of migrations) {
      if (m.version < 7) {
        try {
          await pg.unsafe(
            `UPDATE schema_version SET checksum = $1, filename = $2
             WHERE version = $3 AND checksum IS NULL`,
            [sha256(m.sql), m.filename, m.version],
          );
        } catch {
          /* column may not exist on very old schemas */
        }
      }
    }
  }

  return { tag: "ok", versions: applied };
}

// ---------------------------------------------------------------------------
// I/O boundary — SQLite
// ---------------------------------------------------------------------------

async function getSqliteVersion(repoRoot?: string): Promise<number> {
  const db = await getSqlite(repoRoot);
  const rows = db.prepare("PRAGMA user_version").all() as { user_version: number }[];
  return rows[0]?.user_version ?? 0;
}

async function applySqliteMigrations(repoRoot?: string): Promise<MigrationResult> {
  const db = await getSqlite(repoRoot);
  const currentVersion = await getSqliteVersion(repoRoot);
  const migrations = await loadMigrationFiles("sqlite");
  const applied: number[] = [];

  for (const m of migrations) {
    if (m.version <= currentVersion) continue;

    const statements = stripCommentLines(parseSqlStatements(m.sql));

    const runMigration = db.transaction(() => {
      for (const stmt of statements) {
        db.exec(stmt);
      }
      db.exec(`PRAGMA user_version = ${m.version}`);

      // Store checksum in migration_checksums table (created by migration 0007)
      if (m.version >= 7) {
        db.prepare(
          "INSERT OR REPLACE INTO migration_checksums (version, filename, checksum) VALUES (?, ?, ?)",
        ).run(m.version, m.filename, sha256(m.sql));
      }
    });

    try {
      runMigration();
      applied.push(m.version);
      logEvent({ event: "infra.migrate.apply", version: m.version, backend: "sqlite" });
    } catch (err) {
      return {
        tag: "err",
        error: new Error(`Migration ${m.version} failed: ${err}`, { cause: err }),
      };
    }
  }

  // Backfill checksums for any migrations that predate the checksums table
  const finalVersion = await getSqliteVersion(repoRoot);
  if (finalVersion >= 7) {
    for (const m of migrations) {
      if (m.version < 7) {
        db.prepare(
          "INSERT OR IGNORE INTO migration_checksums (version, filename, checksum) VALUES (?, ?, ?)",
        ).run(m.version, m.filename, sha256(m.sql));
      }
    }
  }

  return { tag: "ok", versions: applied };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getCurrentSchemaVersion(
  backend: "pg" | "sqlite",
  repoRoot?: string,
): Promise<number> {
  return backend === "pg" ? getPgVersion() : getSqliteVersion(repoRoot);
}

export async function getLatestMigrationVersion(backend: "pg" | "sqlite"): Promise<number> {
  const migrations = await loadMigrationFiles(backend);
  return migrations.length > 0 ? migrations[migrations.length - 1].version : 0;
}

export async function applyMigrations(
  backend: "pg" | "sqlite",
  repoRoot?: string,
): Promise<MigrationResult> {
  return backend === "pg" ? applyPgMigrations() : applySqliteMigrations(repoRoot);
}

/**
 * Verify that stored migration checksums match the current migration file contents.
 * Returns `{ tag: 'ok', valid, mismatches }` when verification is possible,
 * or `{ tag: 'unavailable' }` when the checksum schema doesn't exist yet.
 */
export async function verifyMigrationChecksums(
  backend: "pg" | "sqlite",
  repoRoot?: string,
): Promise<ChecksumVerification> {
  const migrations = await loadMigrationFiles(backend);
  const migrationMap = new Map(migrations.map((m) => [m.version, m]));
  const mismatches: string[] = [];

  if (backend === "pg") {
    const pg = await getPg();
    let rows: { version: number; checksum: string | null; filename: string | null }[];
    try {
      rows = (await pg.unsafe(
        "SELECT version, checksum, filename FROM schema_version WHERE checksum IS NOT NULL",
      )) as { version: number; checksum: string | null; filename: string | null }[];
    } catch {
      // checksum column may not exist yet
      return { tag: "unavailable" };
    }

    for (const row of rows) {
      const m = migrationMap.get(row.version);
      if (!m) {
        mismatches.push(`v${row.version}: migration file missing`);
        continue;
      }
      const currentChecksum = sha256(m.sql);
      if (row.checksum && row.checksum !== currentChecksum) {
        mismatches.push(`v${row.version} (${m.filename}): checksum mismatch`);
      }
    }
  } else {
    const db = await getSqlite(repoRoot);
    let rows: { version: number; checksum: string; filename: string }[];
    try {
      rows = db.prepare("SELECT version, checksum, filename FROM migration_checksums").all() as {
        version: number;
        checksum: string;
        filename: string;
      }[];
    } catch {
      // table may not exist yet
      return { tag: "unavailable" };
    }

    for (const row of rows) {
      const m = migrationMap.get(row.version);
      if (!m) {
        mismatches.push(`v${row.version}: migration file missing`);
        continue;
      }
      const currentChecksum = sha256(m.sql);
      if (row.checksum !== currentChecksum) {
        mismatches.push(`v${row.version} (${m.filename}): checksum mismatch`);
      }
    }
  }

  return { tag: "ok", valid: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Global dedup store migrations
// ---------------------------------------------------------------------------

/**
 * Apply global-store migrations against a Postgres connection.
 * Versioned independently from per-repo migrations via global_schema_version.
 */
export async function applyGlobalPgMigrations(): Promise<MigrationResult> {
  const pg = await getPg();
  const migrations = await loadMigrationsFromDir(GLOBAL_MIGRATIONS_DIR, "pg");
  const applied: number[] = [];

  // Read current version (table may not exist yet — first migration creates it)
  let currentVersion = 0;
  try {
    const rows = await pg.unsafe(
      "SELECT version FROM global_schema_version ORDER BY version DESC LIMIT 1",
    );
    if (rows.length > 0) currentVersion = rows[0].version as number;
  } catch {
    currentVersion = 0;
  }

  for (const m of migrations) {
    if (m.version <= currentVersion) continue;
    try {
      await pg.begin(async (tx) => {
        const statements = splitPgStatements(m.sql);
        for (const stmt of statements) {
          await tx.unsafe(stmt);
        }
        await tx.unsafe(
          "INSERT INTO global_schema_version (version, checksum, filename) VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING",
          [m.version, sha256(m.sql), m.filename],
        );
      });
      applied.push(m.version);
      logEvent({ event: "infra.migrate.apply", version: m.version, backend: "pg-global" });
    } catch (err) {
      return {
        tag: "err",
        error: new Error(`Global migration ${m.version} failed: ${err}`, { cause: err }),
      };
    }
  }

  return { tag: "ok", versions: applied };
}

/**
 * Apply global-store migrations against an explicitly-passed SQLite handle.
 * Caller owns the Database (typically the global ~/.codeindex/global.db).
 * Versioned via PRAGMA user_version on that handle.
 */
export async function applyGlobalSqliteMigrations(db: Database): Promise<MigrationResult> {
  const migrations = await loadMigrationsFromDir(GLOBAL_MIGRATIONS_DIR, "sqlite");
  const applied: number[] = [];

  const versionRows = db.prepare("PRAGMA user_version").all() as { user_version: number }[];
  const currentVersion = versionRows[0]?.user_version ?? 0;

  for (const m of migrations) {
    if (m.version <= currentVersion) continue;
    const statements = stripCommentLines(parseSqlStatements(m.sql));

    const runMigration = db.transaction(() => {
      for (const stmt of statements) {
        db.exec(stmt);
      }
      db.exec(`PRAGMA user_version = ${m.version}`);
    });

    try {
      runMigration();
      applied.push(m.version);
      logEvent({ event: "infra.migrate.apply", version: m.version, backend: "sqlite-global" });
    } catch (err) {
      return {
        tag: "err",
        error: new Error(`Global migration ${m.version} failed: ${err}`, { cause: err }),
      };
    }
  }

  return { tag: "ok", versions: applied };
}

/**
 * Create the vec0 virtual table for global content_blobs embeddings.
 * Must be called after applyGlobalSqliteMigrations() so the parent table exists.
 * The dimension count must match the embedding provider config.
 */
export function ensureGlobalSqliteVecTables(db: Database, dimensions: number): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS content_blob_embeddings USING vec0(
      blob_id integer PRIMARY KEY,
      embedding float[${dimensions}]
    )
  `);
}

/**
 * Ensure vec0 virtual tables exist for SQLite.
 * These can't be in SQL migration files because they require the sqlite-vec
 * extension to be loaded first (which happens in getSqlite).
 */
export async function ensureSqliteVecTables(repoRoot?: string): Promise<void> {
  const db = await getSqlite(repoRoot);
  const config = await loadConfig(repoRoot);
  const dims = config.embedding.dimensions;

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS file_embeddings USING vec0(
      file_id integer PRIMARY KEY,
      embedding float[${dims}]
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS dir_concat_embeddings USING vec0(
      dir_id integer PRIMARY KEY,
      embedding float[${dims}]
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS dir_summary_embeddings USING vec0(
      dir_id integer PRIMARY KEY,
      embedding float[${dims}]
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS commit_embeddings USING vec0(
      commit_id integer PRIMARY KEY,
      embedding float[${dims}]
    )
  `);

  // Phase 3 dedup: per-blob embeddings keyed by the surrogate file_blobs.blob_id
  // (vec0 doesn't support composite keys, hence the surrogate column added in
  // migration 0011_sqlite_blob_id.sqlite.sql).
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS file_blob_embeddings USING vec0(
      blob_id integer PRIMARY KEY,
      embedding float[${dims}]
    )
  `);
}

/**
 * Verify that the configured embedding dimensions match the vec table schema.
 * Returns a warning message if mismatched, or null if OK / unable to check.
 */
export async function checkEmbeddingDimensions(
  repoRoot?: string,
  configDimensions = 1536,
): Promise<string | null> {
  try {
    const db = await getSqlite(repoRoot);
    // sqlite-vec stores dimension info in the virtual table schema
    // We can probe by trying to query with a known dimension vector
    const rows = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'file_embeddings'")
      .all() as { sql: string | null }[];

    if (rows.length === 0 || !rows[0].sql) return null;

    const sql = rows[0].sql;
    const match = sql.match(/float\[(\d+)\]/);
    if (!match) return null;

    const tableDimensions = parseInt(match[1], 10);
    if (tableDimensions !== configDimensions) {
      return `Embedding dimension mismatch: config specifies ${configDimensions} but vec tables use ${tableDimensions}. Re-create tables or update config.`;
    }

    return null;
  } catch {
    return null;
  }
}
