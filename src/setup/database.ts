import { SQL } from "bun";
import { loadConfig } from "../config";
import { ensurePgSchema } from "../db/schema";
import { logEvent, withTimingAsync } from "../logging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DatabaseBootstrapResult {
  databaseCreated: boolean;
  extensionInstalled: boolean;
  migrationsApplied: number[];
  error?: string;
}

/** Connection parameters for one-shot PG queries. */
interface PgConnection {
  host: string;
  port: number;
  user: string;
  database: string;
}

// ---------------------------------------------------------------------------
// I/O boundary — all database side effects live here
// ---------------------------------------------------------------------------

/**
 * Execute a parameterized query against a specific database using a
 * short-lived connection (bypasses the singleton pool).
 *
 * Accepts a pre-built SQL tagged template or a simple statement string.
 * For parameterized queries, callers should use `pgOneShot`.
 */
async function pgOneShot(
  conn: PgConnection,
  query: string,
  params: unknown[] = [],
): Promise<unknown[]> {
  const sql = new SQL({
    hostname: conn.host,
    port: conn.port,
    database: conn.database,
    username: conn.user,
    max: 1,
  });
  try {
    return [...(await sql.unsafe(query, params))];
  } finally {
    await sql.close();
  }
}

// ---------------------------------------------------------------------------
// Pure query helpers — return booleans/void, no logging or orchestration
// ---------------------------------------------------------------------------

/** Check if a PostgreSQL server is reachable. */
export async function pgServerReachable(
  host: string,
  port: number,
  user: string,
): Promise<boolean> {
  try {
    await pgOneShot({ host, port, user, database: "postgres" }, "SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/** Check if a PostgreSQL database exists (parameterized — no SQL injection). */
export async function pgDatabaseExists(
  host: string,
  port: number,
  user: string,
  database: string,
): Promise<boolean> {
  try {
    const rows = (await pgOneShot(
      { host, port, user, database: "postgres" },
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [database],
    )) as { "?column?"?: number }[];
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Create a PostgreSQL database. */
export async function pgCreateDatabase(
  host: string,
  port: number,
  user: string,
  database: string,
): Promise<void> {
  // Database identifiers cannot be parameterized — validate the name
  // to prevent injection (allow only alphanumeric, underscore, hyphen).
  if (!/^[\w-]+$/.test(database)) {
    throw new Error(`Invalid database name: ${database}`);
  }
  await pgOneShot({ host, port, user, database: "postgres" }, `CREATE DATABASE "${database}"`);
}

/** Check if pgvector extension is available. */
export async function pgVectorAvailable(
  host: string,
  port: number,
  user: string,
  database: string,
): Promise<boolean> {
  try {
    const rows = (await pgOneShot(
      { host, port, user, database },
      "SELECT 1 FROM pg_available_extensions WHERE name = $1",
      ["vector"],
    )) as { "?column?"?: number }[];
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Install pgvector extension in target database. */
export async function pgInstallVector(
  host: string,
  port: number,
  user: string,
  database: string,
): Promise<void> {
  await pgOneShot({ host, port, user, database }, "CREATE EXTENSION IF NOT EXISTS vector");
}

// ---------------------------------------------------------------------------
// Bootstrap orchestration — pure decision logic + I/O execution
// ---------------------------------------------------------------------------

/**
 * Full PostgreSQL bootstrap: create DB if needed, install pgvector, run migrations.
 * Emits a single wide event at completion with the full result context.
 */
export async function bootstrapPostgres(): Promise<DatabaseBootstrapResult> {
  return withTimingAsync("infra.postgres.bootstrap", {}, async () => {
    const config = await loadConfig();
    const { host, port, user, database } = config.pg;

    // 1. Create database if it doesn't exist
    const exists = await pgDatabaseExists(host, port, user, database);
    const databaseCreated = !exists;
    if (databaseCreated) {
      await pgCreateDatabase(host, port, user, database);
    }

    // 2. Check pgvector availability
    const hasVector = await pgVectorAvailable(host, port, user, database);
    if (!hasVector) {
      const result: DatabaseBootstrapResult = {
        databaseCreated,
        extensionInstalled: false,
        migrationsApplied: [],
        error: "pgvector extension is not available. Install it first: brew install pgvector",
      };
      logEvent({
        event: "infra.postgres.bootstrap",
        databaseCreated,
        extensionInstalled: false,
        "error.type": "MissingExtension",
        "error.message": result.error,
      });
      return result;
    }

    // 3. Install pgvector extension
    await pgInstallVector(host, port, user, database);

    // 4. Run migrations
    const migrationsApplied = await ensurePgSchema();

    const result: DatabaseBootstrapResult = {
      databaseCreated,
      extensionInstalled: true,
      migrationsApplied,
    };

    logEvent({
      event: "infra.postgres.bootstrap",
      databaseCreated,
      extensionInstalled: true,
      migrationsApplied: migrationsApplied.length,
    });

    return result;
  });
}
