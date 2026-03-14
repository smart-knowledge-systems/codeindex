import { createHash } from "crypto";
import { readdir, readFile } from "fs/promises";
import path from "path";
import { getPg } from "./pg";
import { getSqlite } from "./sqlite";

const MIGRATIONS_DIR = path.join(import.meta.dir, "../../migrations");

interface MigrationFile {
  version: number;
  filename: string;
  sql: string;
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

    // Run each migration in a transaction
    await pg.unsafe("BEGIN");
    try {
      // Split on semicolons and execute each statement
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

      for (const stmt of statements) {
        await pg.unsafe(stmt);
      }

      // Update version with checksum if the migration didn't already do it
      if (m.version > 1) {
        await pg.unsafe(
          "INSERT INTO schema_version (version, checksum, filename) VALUES ($1, $2, $3)",
          [m.version, sha256(m.sql), m.filename],
        );
      }

      await pg.unsafe("COMMIT");
      applied.push(m.version);
    } catch (err) {
      await pg.unsafe("ROLLBACK");
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
    } catch (err) {
      throw new Error(`Migration ${m.version} failed: ${err}`, { cause: err });
    }
  }

  // Backfill checksums for migrations applied before 0007
  if (applied.includes(7)) {
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

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS file_embeddings USING vec0(
      file_id integer PRIMARY KEY,
      embedding float[1536]
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
    CREATE VIRTUAL TABLE IF NOT EXISTS commit_embeddings USING vec0(
      commit_id integer PRIMARY KEY,
      embedding float[1536]
    )
  `);
}
