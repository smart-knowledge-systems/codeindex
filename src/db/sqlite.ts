import {
  getSqlite as easierGetSqlite,
  closeSqlite as easierCloseSqlite,
} from "@easier-idx/core/db/sqlite";
import type { SqliteDatabase } from "@easier-idx/core/db/sqlite";
import { loadConfig } from "../config";

export type { SqliteDatabase };

/** @impure Opens (or returns cached) SQLite connection. */
export async function getSqlite(repoRoot?: string): Promise<SqliteDatabase> {
  const config = await loadConfig(repoRoot);
  return easierGetSqlite(config.sqlite, repoRoot);
}

export async function sqliteUnsafe(sql: string, params: unknown[] = []) {
  const db = await getSqlite();
  return db
    .prepare(sql)
    .all(...(params as (string | number | bigint | boolean | null | Uint8Array)[]));
}

export async function closeSqlite() {
  easierCloseSqlite();
}
