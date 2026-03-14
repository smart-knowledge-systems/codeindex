import { SQL } from "bun";
import { loadConfig } from "../config";

let _pg: InstanceType<typeof SQL> | null = null;

export async function getPg(): Promise<InstanceType<typeof SQL>> {
  if (_pg) return _pg;
  const config = await loadConfig();
  _pg = new SQL({
    hostname: config.pg.host,
    port: config.pg.port,
    database: config.pg.database,
    username: config.pg.user,
    max: parseInt(process.env.CODEINDEX_PG_MAX_CONNECTIONS ?? "20", 10) || 20,
  });
  return _pg;
}

export async function pgUnsafe(sql: string, params: unknown[] = []) {
  const pg = await getPg();
  return pg.unsafe(sql, params as never[]);
}

export async function closePg() {
  if (_pg) {
    await _pg.close();
    _pg = null;
  }
}
