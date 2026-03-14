import { SQL } from "bun";
import { loadConfig } from "../config";
import { ensurePgSchema } from "../db/schema";

export interface DatabaseBootstrapResult {
  databaseCreated: boolean;
  extensionInstalled: boolean;
  migrationsApplied: number[];
  error?: string;
}

/**
 * One-shot query against a specific database (bypasses the singleton pool).
 * Used to connect to `postgres` for CREATE DATABASE operations.
 */
async function pgOneShot(
  host: string,
  port: number,
  user: string,
  database: string,
  query: string,
): Promise<unknown[]> {
  const sql = new SQL({
    hostname: host,
    port,
    database,
    username: user,
    max: 1,
  });
  try {
    return [...(await sql.unsafe(query))];
  } finally {
    await sql.close();
  }
}

/** Check if a PostgreSQL server is reachable. */
export async function pgServerReachable(
  host: string,
  port: number,
  user: string,
): Promise<boolean> {
  try {
    await pgOneShot(host, port, user, "postgres", "SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/** Check if a PostgreSQL database exists. */
export async function pgDatabaseExists(
  host: string,
  port: number,
  user: string,
  database: string,
): Promise<boolean> {
  try {
    const rows = (await pgOneShot(
      host,
      port,
      user,
      "postgres",
      `SELECT 1 FROM pg_database WHERE datname = '${database}'`,
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
  await pgOneShot(host, port, user, "postgres", `CREATE DATABASE "${database}"`);
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
      host,
      port,
      user,
      database,
      "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'",
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
  await pgOneShot(host, port, user, database, "CREATE EXTENSION IF NOT EXISTS vector");
}

/**
 * Full PostgreSQL bootstrap: create DB if needed, install pgvector, run migrations.
 */
export async function bootstrapPostgres(): Promise<DatabaseBootstrapResult> {
  const config = await loadConfig();
  const { host, port, user, database } = config.pg;
  const result: DatabaseBootstrapResult = {
    databaseCreated: false,
    extensionInstalled: false,
    migrationsApplied: [],
  };

  // 1. Create database if it doesn't exist
  const exists = await pgDatabaseExists(host, port, user, database);
  if (!exists) {
    await pgCreateDatabase(host, port, user, database);
    result.databaseCreated = true;
  }

  // 2. Install pgvector
  const hasVector = await pgVectorAvailable(host, port, user, database);
  if (!hasVector) {
    result.error = "pgvector extension is not available. Install it first: brew install pgvector";
    return result;
  }
  await pgInstallVector(host, port, user, database);
  result.extensionInstalled = true;

  // 3. Run migrations
  const applied = await ensurePgSchema();
  result.migrationsApplied = applied;

  return result;
}
