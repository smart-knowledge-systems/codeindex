import { loadConfig } from "../config";
import { pgUnsafe } from "./pg";
import { getSqlite } from "./sqlite";

/**
 * Look up a repo's numeric ID by root path.
 * Returns null if not found.
 */
export async function getRepoIdByPath(repoRoot: string, rootPath?: string): Promise<number | null> {
  const config = await loadConfig(repoRoot);
  const target = rootPath ?? repoRoot;

  if (config.store === "pg") {
    const rows = (await pgUnsafe("SELECT id FROM repos WHERE root_path = $1", [target])) as {
      id: string;
    }[];
    return rows.length > 0 ? parseInt(rows[0].id) : null;
  }

  const db = await getSqlite(repoRoot);
  const row = db.prepare("SELECT id FROM repos WHERE root_path = ?").get(target) as {
    id: number;
  } | null;
  return row?.id ?? null;
}

/**
 * Look up a repo's numeric ID by root path.
 * Throws if not found.
 */
export async function requireRepoId(
  repoRoot: string,
  rootPath?: string,
  errorMsg = "Repo not indexed. Run: codeindex reindex",
): Promise<number> {
  const id = await getRepoIdByPath(repoRoot, rootPath);
  if (id === null) throw new Error(errorMsg);
  return id;
}
