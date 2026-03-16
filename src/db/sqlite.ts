import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { loadConfig } from "../config";
import path from "path";
import { existsSync } from "fs";

// Use Homebrew SQLite on macOS if available (supports dynamic extensions)
const HOMEBREW_SQLITE = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
if (process.platform === "darwin" && existsSync(HOMEBREW_SQLITE)) {
  Database.setCustomSQLite(HOMEBREW_SQLITE);
}

// Singleton — module-level mutable state for the database connection.
// This is an intentional impure boundary; all database I/O flows through here.
let _db: Database | null = null;

/** @impure Opens (or returns cached) SQLite connection. */
export async function getSqlite(repoRoot?: string): Promise<Database> {
  if (_db) return _db;
  const config = await loadConfig(repoRoot);
  const dbPath = path.isAbsolute(config.sqlite.path)
    ? config.sqlite.path
    : path.join(repoRoot ?? process.cwd(), config.sqlite.path);
  _db = new Database(dbPath);
  _db.exec("PRAGMA journal_mode=WAL");
  sqliteVec.load(_db);
  return _db;
}

export async function sqliteUnsafe(sql: string, params: unknown[] = []) {
  const db = await getSqlite();
  return db
    .prepare(sql)
    .all(...(params as (string | number | bigint | boolean | null | Uint8Array)[]));
}

export async function closeSqlite() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
