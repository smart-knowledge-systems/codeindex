import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import type { PolicyContext } from "./types";

/**
 * Execute a query against the correct store backend.
 *
 * Provide a pg SQL string (with $1, $2... params) and a sqlite SQL string
 * (with ? params). Both receive the same params array. Returns the rows
 * normalized to a common shape by the caller.
 */
export async function storeQuery<T>(
  ctx: PolicyContext,
  pgSql: string,
  sqliteSql: string,
  params: (string | number | bigint | boolean | null | Uint8Array)[],
): Promise<T> {
  if (ctx.store === "pg") {
    return (await pgUnsafe(pgSql, params)) as T;
  }
  const db = await getSqlite(ctx.repoRoot);
  return db.prepare(sqliteSql).all(...params) as T;
}

/**
 * Execute a query that returns a single row against the correct store backend.
 */
export async function storeQueryOne<T>(
  ctx: PolicyContext,
  pgSql: string,
  sqliteSql: string,
  params: (string | number | bigint | boolean | null | Uint8Array)[],
): Promise<T> {
  if (ctx.store === "pg") {
    const rows = (await pgUnsafe(pgSql, params)) as T[];
    return rows[0];
  }
  const db = await getSqlite(ctx.repoRoot);
  return db.prepare(sqliteSql).get(...params) as T;
}
