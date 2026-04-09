import { getPg as easierGetPg, closePg as easierClosePg } from "@easier-idx/core/db/pg";
import type { PgClient } from "@easier-idx/core/db/pg";
import { loadConfig } from "../config";

export type { PgClient };
export type { PgTx } from "@easier-idx/core/db/pg";

/** @impure Opens (or returns cached) PostgreSQL connection pool. */
export async function getPg(): Promise<PgClient> {
  const config = await loadConfig();
  const maxConn = parseInt(process.env.CODEINDEX_PG_MAX_CONNECTIONS ?? "20", 10) || 20;
  return easierGetPg(config.pg, maxConn);
}

export async function pgUnsafe(sql: string, params: unknown[] = []) {
  const pg = await getPg();
  return pg.unsafe(sql, params as never[]);
}

export async function closePg() {
  await easierClosePg();
}
