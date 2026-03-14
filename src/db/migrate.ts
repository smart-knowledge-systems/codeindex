import { createHash } from "crypto";
import { readdir, readFile } from "fs/promises";
import path from "path";
import { getPg } from "./pg";
import { getSqlite } from "./sqlite";
import { logEvent } from "../logging";
import { loadConfig } from "../config";

const MIGRATIONS_DIR = path.join(import.meta.dir, "../../migrations");

interface MigrationFile {
  version: number;
  filename: string;
  sql: string;
}

/**
 * Split SQL into statements, preserving dollar-quoted blocks (DO $$ ... $$;).
 * Strips comment-only lines and empty statements.
 */
function splitPgStatements(sql: string): string[] {
  const results: string[] = [];
  let current = "";
  let inDollarQuote = false;

  const lines = sql.split("\n");
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!inDollarQuote && trimmed.startsWith("--")) continue;

    current += (current ? "\n" : "") + line;

    // Toggle dollar-quoting state
    const dollarMatches = line.match(/\$\$/g);
    if (dollarMatches) {
      for (const _ of dollarMatches) {
        inDollarQuote = !inDollarQuote;
      }
    }

    // Only split on ; when not inside a dollar-quoted block
    if (!inDollarQuote && line.trimEnd().endsWith(";")) {
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

/** Compute SHA-256 hex digest of a string. */
function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Read and sort migration files for the given backend.
 * Files must match the pattern: NNNN_description.{pg,sqlite}.sql
 */
async function loadMigrationFiles(backend: "pg" | "sqlite"): Promise<MigrationFile[]> {
  const suffix = `.${backend}.sql`;
  let entries: string[];
  try {
    entries = await readdir(MIGRATIONS_DIR);
  } catch {
    return [];
  }

  const migrations: MigrationFile[] = [];
  for (const filename of entries) {
    if (!filename.endsWith(suffix)) continue;
    const versionStr = filename.split("_")[0];
    const version = parseInt(versionStr, 10);
    if (isNaN(version)) continue;

    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), "utf-8");
    migrations.push({ version, filename, sql });
  }

  return migrations.sort((a, b) => a.version - b.version);
}

// ---------------------------------------------------------------------------
// PostgreSQL
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

async function applyPgMigrations(): Promise<number[]> {
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
      logEvent({ event: "migrate", version: m.version, backend: "pg" });
    } catch (err) {
      throw new Error(`Migration ${m.version} failed: ${err}`, { cause: err });
    }
  }

  return applied;
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

async function getSqliteVersion(repoRoot?: string): Promise<number> {
  const db = await getSqlite(repoRoot);
  const rows = db.prepare("PRAGMA user_version").all() as { user_version: number }[];
  return rows[0]?.user_version ?? 0;
}

async function applySqliteMigrations(repoRoot?: string): Promise<number[]> {
  const db = await getSqlite(repoRoot);
  const currentVersion = await getSqliteVersion(repoRoot);
  const migrations = await loadMigrationFiles("sqlite");
  const applied: number[] = [];

  for (const m of migrations) {
    if (m.version <= currentVersion) continue;

    const statements = m.sql
      .split(";")
      .map((s) => s.trim())
      .map((s) =>
        s
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((s) => s.length > 0);

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
      logEvent({ event: "migrate", version: m.version, backend: "sqlite" });
    } catch (err) {
      throw new Error(`Migration ${m.version} failed: ${err}`, { cause: err });
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

  return applied;
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
): Promise<number[]> {
  return backend === "pg" ? applyPgMigrations() : applySqliteMigrations(repoRoot);
}

/**
 * Verify that stored migration checksums match the current migration file contents.
 * Returns valid=true if all checksums match (or no checksums stored yet).
 */
export async function verifyMigrationChecksums(
  backend: "pg" | "sqlite",
  repoRoot?: string,
): Promise<{ valid: boolean; mismatches: string[] }> {
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
      return { valid: true, mismatches: [] };
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
      return { valid: true, mismatches: [] };
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

  return { valid: mismatches.length === 0, mismatches };
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
