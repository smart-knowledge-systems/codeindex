import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { loadConfig } from "../config";
import path from "path";

let _db: Database | null = null;

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
