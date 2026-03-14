import type { SearchResult, RerankingConfig } from "./types";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";

export interface RerankContext {
  store: "pg" | "sqlite";
  repoRoot?: string;
  repoIds: number[];
  reranking: RerankingConfig;
}

/**
 * Second-pass re-ranker that boosts results based on import graph proximity,
 * cross-repo edges, and co-change recency signals. All signals are local (no API calls).
 */
export async function rerank(results: SearchResult[], ctx: RerankContext): Promise<SearchResult[]> {
  if (results.length === 0) return results;

  // Collect file IDs from results for batch querying
  const resultFileIds = await resolveFileIds(results, ctx);
  if (resultFileIds.size === 0) return results;

  const topFileIds = [...resultFileIds.values()].slice(0, 50);
  const topSet = new Set(topFileIds);

  const [importBoosts, crossRepoBoosts, coChangeBoosts] = await Promise.all([
    getImportProximityBoosts(topFileIds, topSet, resultFileIds, ctx),
    getCrossRepoBoosts(topFileIds, topSet, resultFileIds, ctx),
    getCoChangeBoosts(topFileIds, topSet, resultFileIds, ctx),
  ]);

  // Work on shallow copies to avoid mutating caller's SearchResult objects
  const boosted = results.map((result) => {
    const key = resultKey(result);
    const fileId = resultFileIds.get(key);
    if (fileId === undefined) return result;

    const importBoost = (importBoosts.get(fileId) ?? 0) * ctx.reranking.importProximityWeight;
    const crossRepoBoost = (crossRepoBoosts.get(fileId) ?? 0) * ctx.reranking.crossRepoWeight;
    const coChangeBoost = (coChangeBoosts.get(fileId) ?? 0) * ctx.reranking.coChangeWeight;
    const totalBoost = importBoost + crossRepoBoost + coChangeBoost;

    if (totalBoost === 0) return result;
    return { ...result, finalScore: result.finalScore + totalBoost };
  });

  boosted.sort((a, b) => b.finalScore - a.finalScore);
  return boosted;
}

function resultKey(r: SearchResult): string {
  return `${r.repoId ?? ""}:${r.filePath}`;
}

async function resolveFileIds(
  results: SearchResult[],
  ctx: RerankContext,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const paths = results.map((r) => r.filePath);
  if (paths.length === 0) return map;

  if (ctx.store === "pg") {
    const placeholders = ctx.repoIds.map((_, i) => `$${i + 1}`).join(",");
    const pathPlaceholders = paths.map((_, i) => `$${ctx.repoIds.length + i + 1}`).join(",");
    const rows = (await pgUnsafe(
      `SELECT id, repo_id, file_path FROM files WHERE repo_id IN (${placeholders}) AND file_path IN (${pathPlaceholders})`,
      [...ctx.repoIds, ...paths],
    )) as Array<{ id: string; repo_id: string; file_path: string }>;
    for (const row of rows) {
      map.set(`${row.repo_id}:${row.file_path}`, parseInt(row.id, 10));
    }
  } else {
    const db = await getSqlite(ctx.repoRoot);
    const repoPlaceholders = ctx.repoIds.map(() => "?").join(",");
    const pathPlaceholders = paths.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, repo_id, file_path FROM files WHERE repo_id IN (${repoPlaceholders}) AND file_path IN (${pathPlaceholders})`,
      )
      .all(...ctx.repoIds, ...paths) as Array<{
      id: number;
      repo_id: number;
      file_path: string;
    }>;
    for (const row of rows) {
      map.set(`${row.repo_id}:${row.file_path}`, row.id);
    }
  }

  // Also map results without repoId by filePath match
  for (const r of results) {
    const key = resultKey(r);
    if (!map.has(key)) {
      for (const [k, v] of map) {
        if (k.endsWith(`:${r.filePath}`)) {
          map.set(key, v);
          break;
        }
      }
    }
  }

  return map;
}

/**
 * Boost files that import or are imported by top-scoring results.
 */
async function getImportProximityBoosts(
  topFileIds: number[],
  topSet: Set<number>,
  allFileIds: Map<string, number>,
  ctx: RerankContext,
): Promise<Map<number, number>> {
  const boosts = new Map<number, number>();
  if (topFileIds.length === 0) return boosts;

  const allIds = new Set(allFileIds.values());

  try {
    if (ctx.store === "pg") {
      const placeholders = topFileIds.map((_, i) => `$${i + 1}`).join(",");
      // Files imported by top results
      const importedRows = (await pgUnsafe(
        `SELECT DISTINCT resolved_file_id AS fid FROM file_imports WHERE source_file_id IN (${placeholders}) AND resolved_file_id IS NOT NULL`,
        topFileIds,
      )) as Array<{ fid: string }>;
      // Files that import top results
      const importerRows = (await pgUnsafe(
        `SELECT DISTINCT source_file_id AS fid FROM file_imports WHERE resolved_file_id IN (${placeholders})`,
        topFileIds,
      )) as Array<{ fid: string }>;

      const connected = new Set([
        ...importedRows.map((r) => parseInt(r.fid, 10)),
        ...importerRows.map((r) => parseInt(r.fid, 10)),
      ]);
      for (const fid of connected) {
        if (allIds.has(fid) && !topSet.has(fid)) {
          boosts.set(fid, 1.0);
        }
      }
    } else {
      const db = await getSqlite(ctx.repoRoot);
      const placeholders = topFileIds.map(() => "?").join(",");
      const importedRows = db
        .prepare(
          `SELECT DISTINCT resolved_file_id AS fid FROM file_imports WHERE source_file_id IN (${placeholders}) AND resolved_file_id IS NOT NULL`,
        )
        .all(...topFileIds) as Array<{ fid: number }>;
      const importerRows = db
        .prepare(
          `SELECT DISTINCT source_file_id AS fid FROM file_imports WHERE resolved_file_id IN (${placeholders})`,
        )
        .all(...topFileIds) as Array<{ fid: number }>;

      const connected = new Set([
        ...importedRows.map((r) => r.fid),
        ...importerRows.map((r) => r.fid),
      ]);
      for (const fid of connected) {
        if (allIds.has(fid) && !topSet.has(fid)) {
          boosts.set(fid, 1.0);
        }
      }
    }
  } catch {
    // Table may not exist in older schemas
  }

  return boosts;
}

/**
 * Boost files connected via cross-repo edges.
 */
async function getCrossRepoBoosts(
  topFileIds: number[],
  topSet: Set<number>,
  allFileIds: Map<string, number>,
  ctx: RerankContext,
): Promise<Map<number, number>> {
  const boosts = new Map<number, number>();
  if (topFileIds.length === 0) return boosts;

  const allIds = new Set(allFileIds.values());

  try {
    if (ctx.store === "pg") {
      const placeholders = topFileIds.map((_, i) => `$${i + 1}`).join(",");
      const rows = (await pgUnsafe(
        `SELECT DISTINCT target_file_id AS fid FROM cross_repo_edges WHERE source_file_id IN (${placeholders}) AND target_file_id IS NOT NULL
         UNION
         SELECT DISTINCT source_file_id AS fid FROM cross_repo_edges WHERE target_file_id IN (${placeholders})`,
        [...topFileIds, ...topFileIds],
      )) as Array<{ fid: string }>;

      for (const row of rows) {
        const fid = parseInt(row.fid, 10);
        if (allIds.has(fid) && !topSet.has(fid)) {
          boosts.set(fid, 1.0);
        }
      }
    } else {
      const db = await getSqlite(ctx.repoRoot);
      const placeholders = topFileIds.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT DISTINCT target_file_id AS fid FROM cross_repo_edges WHERE source_file_id IN (${placeholders}) AND target_file_id IS NOT NULL
           UNION
           SELECT DISTINCT source_file_id AS fid FROM cross_repo_edges WHERE target_file_id IN (${placeholders})`,
        )
        .all(...topFileIds, ...topFileIds) as Array<{ fid: number }>;

      for (const row of rows) {
        if (allIds.has(row.fid)) {
          boosts.set(row.fid, 1.0);
        }
      }
    }
  } catch {
    // Table may not exist in older schemas
  }

  return boosts;
}

/**
 * Boost files that share recent commits with top-scoring results.
 * Uses recency as the signal strength (lower recency = more recent = stronger boost).
 */
async function getCoChangeBoosts(
  topFileIds: number[],
  topSet: Set<number>,
  allFileIds: Map<string, number>,
  ctx: RerankContext,
): Promise<Map<number, number>> {
  const boosts = new Map<number, number>();
  if (topFileIds.length === 0) return boosts;

  const allIds = new Set(allFileIds.values());

  try {
    if (ctx.store === "pg") {
      const placeholders = topFileIds.map((_, i) => `$${i + 1}`).join(",");
      // Find commits associated with top files, then find other files in those commits
      const rows = (await pgUnsafe(
        `SELECT fc2.file_id AS fid, MIN(fc2.recency) AS best_recency
         FROM file_commits fc1
         JOIN file_commits fc2 ON fc1.commit_id = fc2.commit_id AND fc1.file_id != fc2.file_id
         WHERE fc1.file_id IN (${placeholders})
         GROUP BY fc2.file_id`,
        topFileIds,
      )) as Array<{ fid: string; best_recency: string }>;

      for (const row of rows) {
        const fid = parseInt(row.fid, 10);
        if (allIds.has(fid) && !topSet.has(fid)) {
          // Decay boost by recency: recency 0 = most recent = full boost
          const recency = parseInt(row.best_recency, 10);
          const boost = 1.0 / (1 + recency);
          boosts.set(fid, boost);
        }
      }
    } else {
      const db = await getSqlite(ctx.repoRoot);
      const placeholders = topFileIds.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT fc2.file_id AS fid, MIN(fc2.recency) AS best_recency
           FROM file_commits fc1
           JOIN file_commits fc2 ON fc1.commit_id = fc2.commit_id AND fc1.file_id != fc2.file_id
           WHERE fc1.file_id IN (${placeholders})
           GROUP BY fc2.file_id`,
        )
        .all(...topFileIds) as Array<{ fid: number; best_recency: number }>;

      for (const row of rows) {
        if (allIds.has(row.fid) && !topSet.has(row.fid)) {
          const boost = 1.0 / (1 + row.best_recency);
          boosts.set(row.fid, boost);
        }
      }
    }
  } catch {
    // Table may not exist in older schemas
  }

  return boosts;
}
