// ---------------------------------------------------------------------------
// SQLite search implementation
// ---------------------------------------------------------------------------

import path from "path";
import { getSqlite } from "../db/sqlite";
import { serializeEmbedding } from "../db/util";
import type { SearchOptions, SearchResult, ScoringConfig } from "./types";
import type {
  SqliteFileRow,
  SqliteDirRow,
  SqliteCommitRow,
  SqliteFileLinkRow,
  SqliteRepoRow,
} from "./types-internal";
import { resolveLangExtensions, parseSince } from "./scope";
import {
  computeFileScore,
  computeDirScore,
  buildFileExplanation,
  buildDirExplanation,
} from "./scoring";
import { buildBM25Context, computeAvgTokenCount } from "./bm25-helpers";

/**
 * Pure: build the SQL + bind params for the junction-based file KNN query
 * (`file_blob_embeddings` MATCH → `file_blobs` JOIN `repo_files`). Mirrors
 * the PG buildBlobFileQuery in search-pg.ts. Exported for unit testing.
 */
export function buildBlobFileQuerySqlite(args: {
  repoIds: number[];
  langExts: string[] | null;
  dirFilters: string[] | null;
  sinceIso: string | null;
}): { sql: string; params: string[] } {
  const { repoIds, langExts, dirFilters, sinceIso } = args;
  for (const id of repoIds) {
    if (typeof id !== "number" || !Number.isInteger(id)) {
      throw new Error(`Invalid repo ID: ${String(id)}`);
    }
  }
  const repoIdList = repoIds.join(",");
  const params: string[] = [];
  let filterSql = "";

  if (langExts && langExts.length > 0) {
    filterSql += ` AND fb.file_type IN (${langExts.map(() => "?").join(",")})`;
    params.push(...langExts);
  }
  if (dirFilters && dirFilters.length > 0) {
    const dirConds = dirFilters.map(() => "rf.file_path LIKE ?").join(" OR ");
    filterSql += ` AND (${dirConds})`;
    params.push(...dirFilters.map((d) => `${d.replace(/\/$/, "")}/%`));
  }
  if (sinceIso) {
    // file_commits still references files.id during the dual-write window;
    // resolve via the legacy files table to preserve identical semantics.
    filterSql +=
      ` AND EXISTS (SELECT 1 FROM files f` +
      ` JOIN file_commits fc ON fc.file_id = f.id` +
      ` JOIN commits c ON c.id = fc.commit_id` +
      ` WHERE f.repo_id = rf.repo_id AND f.file_path = rf.file_path` +
      ` AND c.authored_at >= ?)`;
    params.push(sinceIso);
  }

  // KNN over file_blob_embeddings then JOIN to file_blobs (for skeleton/type)
  // and repo_files (for repo_id/file_path scoping). The vec0 MATCH does not
  // accept arbitrary WHERE clauses, so the lang/dir/since filters are applied
  // post-KNN as part of the outer JOIN.
  const sql =
    `SELECT rf.repo_id, rf.file_path, fb.skeleton, fb.file_type,` +
    ` fbe.distance, fb.blob_id` +
    ` FROM file_blob_embeddings fbe` +
    ` JOIN file_blobs fb ON fb.blob_id = fbe.blob_id` +
    ` JOIN repo_files rf` +
    `   ON rf.content_hash = fb.content_hash` +
    `  AND rf.provider     = fb.provider` +
    `  AND rf.model        = fb.model` +
    `  AND rf.dimensions   = fb.dimensions` +
    ` WHERE fbe.embedding MATCH ? AND fbe.k = ?` +
    `   AND rf.repo_id IN (${repoIdList})${filterSql}`;

  return { sql, params };
}

export async function searchSqlite(
  repoIds: number[],
  currentRepoId: number,
  repoRoot: string,
  queryEmbedding: number[],
  query: string,
  options: Required<Omit<SearchOptions, "embeddingCache">>,
  scoring: ScoringConfig,
  languageProfiles?: Record<string, Partial<ScoringConfig>>,
  useBlobSchema: boolean = false,
): Promise<SearchResult[]> {
  const db = await getSqlite(repoRoot);
  const embBuf = serializeEmbedding(queryEmbedding);
  const repoIdList = repoIds.join(",");
  // Resolve scope filters
  const langExts =
    options.lang && options.lang.length > 0 ? resolveLangExtensions(options.lang) : null;
  const dirFilters = options.dir && options.dir.length > 0 ? options.dir : null;
  const sinceDate = options.since ? parseSince(options.since) : null;

  // Increase KNN over-fetch when scope filters are active to avoid under-returning
  const hasFilters = !!(langExts || dirFilters || sinceDate);
  const knnLimit = Math.max((options.topN || 50) * (hasFilters ? 10 : 3), hasFilters ? 500 : 200);

  // --- Repo info map ---
  const repoInfoRows = db
    .prepare(`SELECT id, root_path, name FROM repos WHERE id IN (${repoIdList})`)
    .all() as SqliteRepoRow[];
  const repoInfoMap = new Map<number, { name: string; rootPath: string }>();
  for (const r of repoInfoRows) {
    repoInfoMap.set(r.id, { name: r.name, rootPath: r.root_path });
  }

  // --- Files (KNN via vec0 MATCH) ---
  // KNN queries in sqlite-vec don't support arbitrary WHERE; post-filter instead
  let fileFilterSql = "";
  const fileFilterParams: string[] = [];
  if (langExts) {
    fileFilterSql += ` AND f.file_type IN (${langExts.map(() => "?").join(",")})`;
    fileFilterParams.push(...langExts);
  }
  if (dirFilters) {
    const dirConds = dirFilters.map(() => "f.file_path LIKE ?").join(" OR ");
    fileFilterSql += ` AND (${dirConds})`;
    fileFilterParams.push(...dirFilters.map((d) => `${d.replace(/\/$/, "")}/%`));
  }
  if (sinceDate) {
    fileFilterSql += ` AND f.id IN (SELECT fc.file_id FROM file_commits fc JOIN commits c ON c.id = fc.commit_id WHERE c.authored_at >= ?)`;
    fileFilterParams.push(sinceDate.toISOString());
  }

  let fileRows: SqliteFileRow[];
  if (useBlobSchema) {
    const built = buildBlobFileQuerySqlite({
      repoIds,
      langExts,
      dirFilters,
      sinceIso: sinceDate ? sinceDate.toISOString() : null,
    });
    const junctionRows = db.prepare(built.sql).all(embBuf, knnLimit, ...built.params) as Array<{
      repo_id: number;
      file_path: string;
      skeleton: string | null;
      file_type: string;
      distance: number;
      blob_id: number;
    }>;

    // file_commits still references files.id during the dual-write window;
    // resolve a legacy id per (repo_id, file_path) so BM25 keying and the
    // commit-link join below keep working unchanged.
    const idMap = new Map<string, number>();
    if (junctionRows.length > 0) {
      const repoIdSet = [...new Set(junctionRows.map((r) => r.repo_id))];
      const pathSet = [...new Set(junctionRows.map((r) => r.file_path))];
      const idRows = db
        .prepare(
          `SELECT id, repo_id, file_path FROM files
           WHERE repo_id IN (${repoIdSet.join(",")})
             AND file_path IN (${pathSet.map(() => "?").join(",")})`,
        )
        .all(...pathSet) as { id: number; repo_id: number; file_path: string }[];
      for (const r of idRows) {
        idMap.set(`${r.repo_id}:${r.file_path}`, r.id);
      }
    }

    // Synthetic id fallback for blob-only rows with no legacy files.id —
    // negative space avoids collisions with real ids.
    let syntheticId = -1;
    fileRows = junctionRows.map((r) => {
      const id = idMap.get(`${r.repo_id}:${r.file_path}`) ?? syntheticId--;
      return {
        id,
        repo_id: r.repo_id,
        file_path: r.file_path,
        skeleton: r.skeleton,
        file_type: r.file_type,
        distance: r.distance,
      };
    });
  } else {
    fileRows = db
      .prepare(
        `SELECT f.id, f.repo_id, f.file_path, f.skeleton, f.file_type,
                fe.distance
         FROM file_embeddings fe
         JOIN files f ON f.id = fe.file_id
         WHERE fe.embedding MATCH ? AND fe.k = ?
           AND f.repo_id IN (${repoIdList})${fileFilterSql}`,
      )
      .all(embBuf, knnLimit, ...fileFilterParams) as SqliteFileRow[];
  }

  // --- Directories (KNN via vec0 MATCH for concat, then point lookup for summary) ---
  let dirFilterSql = "";
  const dirFilterParams: string[] = [];
  if (dirFilters) {
    const dirConds = dirFilters.map(() => "(d.dir_path LIKE ? OR d.dir_path = ?)").join(" OR ");
    dirFilterSql += ` AND (${dirConds})`;
    dirFilterParams.push(
      ...dirFilters.flatMap((d) => {
        const clean = d.replace(/\/$/, "");
        return [`${clean}/%`, clean];
      }),
    );
  }

  const dirConcatRows = db
    .prepare(
      `SELECT d.id, d.repo_id, d.dir_path, d.summary,
              dce.distance AS concat_distance
       FROM dir_concat_embeddings dce
       JOIN directories d ON d.id = dce.dir_id
       WHERE dce.embedding MATCH ? AND dce.k = ?
         AND d.repo_id IN (${repoIdList})${dirFilterSql}`,
    )
    .all(embBuf, knnLimit, ...dirFilterParams) as (SqliteDirRow & { concat_distance: number })[];

  // Batch load summary distances for all directories in a single query
  const summaryByDirId = new Map<number, number>();
  if (dirConcatRows.length > 0) {
    const dirIds = dirConcatRows.map((r) => r.id);
    const dirPlaceholders = dirIds.map(() => "?").join(",");
    try {
      const summaryRows = db
        .prepare(
          `SELECT dir_id, vec_distance_cosine(embedding, ?) AS distance
           FROM dir_summary_embeddings WHERE dir_id IN (${dirPlaceholders})`,
        )
        .all(embBuf, ...dirIds) as { dir_id: number; distance: number }[];
      for (const row of summaryRows) {
        summaryByDirId.set(row.dir_id, row.distance);
      }
    } catch {
      // No summary embeddings table or empty
    }
  }
  const dirRows: SqliteDirRow[] = dirConcatRows.map((row) => ({
    ...row,
    summary_distance: summaryByDirId.get(row.id) ?? null,
  }));

  // --- Commits (KNN via vec0 MATCH) ---
  let commitFilterSql = "";
  const commitFilterParams: string[] = [];
  if (sinceDate) {
    commitFilterSql += ` AND c.authored_at >= ?`;
    commitFilterParams.push(sinceDate.toISOString());
  }

  const commitRows = db
    .prepare(
      `SELECT c.id, c.repo_id, c.commit_hash, c.message,
              ce.distance
       FROM commit_embeddings ce
       JOIN commits c ON c.id = ce.commit_id
       WHERE ce.embedding MATCH ? AND ce.k = ?
         AND c.repo_id IN (${repoIdList})${commitFilterSql}`,
    )
    .all(embBuf, knnLimit, ...commitFilterParams) as SqliteCommitRow[];

  // --- File-commit links (point-to-point distance, not KNN) ---
  const linkRows = db
    .prepare(
      `SELECT fc.file_id, fc.commit_id, fc.recency,
              vec_distance_cosine(ce.embedding, ?) AS distance
       FROM file_commits fc
       JOIN commit_embeddings ce ON ce.commit_id = fc.commit_id
       JOIN files f ON f.id = fc.file_id
       WHERE f.repo_id IN (${repoIdList})
         AND fc.recency <= ?`,
    )
    .all(embBuf, scoring.commitDepth) as SqliteFileLinkRow[];

  // Build dir similarity map
  const dirSimByPath = new Map<string, number>();
  const dirSummaryByPath = new Map<string, string | null>();
  for (const d of dirRows) {
    const concatSim = d.concat_distance != null ? 1 - d.concat_distance : 0;
    const summarySim = d.summary_distance != null ? 1 - d.summary_distance : 0;
    const sim = Math.max(concatSim, summarySim);
    dirSimByPath.set(`${d.repo_id}:${d.dir_path}`, sim);
    dirSummaryByPath.set(`${d.repo_id}:${d.dir_path}`, d.summary);
  }

  // Build commit link map
  const linksByFileId = new Map<number, Array<{ recency: number; similarity: number }>>();
  const commitIdsByFileId = new Map<number, string[]>();
  for (const link of linkRows) {
    const links = linksByFileId.get(link.file_id) ?? [];
    links.push({ recency: link.recency, similarity: 1 - link.distance });
    linksByFileId.set(link.file_id, links);

    const ids = commitIdsByFileId.get(link.file_id) ?? [];
    ids.push(String(link.commit_id));
    commitIdsByFileId.set(link.file_id, ids);
  }

  const results: SearchResult[] = [];
  const { minScore, includeSkeleton, includeSummary } = options;
  const { gamma } = scoring;

  // Collect child file scores per directory for child-to-parent propagation
  const childScoresByDir = new Map<string, number[]>();

  // --- BM25 hybrid scoring ---
  const bm25DocsSqlite = fileRows
    .filter((r) => r.skeleton)
    .map((r) => ({ id: String(r.id), text: r.skeleton! }));
  const bm25 = buildBM25Context(bm25DocsSqlite, query);
  const avgTokenCountSqlite = computeAvgTokenCount(fileRows);

  // --- File results ---
  for (const row of fileRows) {
    const fileSim = 1 - row.distance;
    const dirKey = `${row.repo_id}:${path.dirname(row.file_path)}`;

    const score = computeFileScore({
      fileSim,
      fileType: row.file_type,
      skeletonLength: row.skeleton?.length ?? 0,
      avgTokenCount: avgTokenCountSqlite,
      commitLinks: linksByFileId.get(row.id) ?? [],
      dirSim: dirSimByPath.get(dirKey) ?? 0,
      rawBM25: bm25.scores.get(String(row.id)) ?? 0,
      maxBM25: bm25.maxScore,
      minScore,
      scoring,
      languageProfiles,
    });

    if (score.finalScore >= minScore) {
      const scores = childScoresByDir.get(dirKey) ?? [];
      scores.push(score.finalScore);
      childScoresByDir.set(dirKey, scores);
    }
    if (score.finalScore < minScore) continue;

    const repoInfo = repoInfoMap.get(row.repo_id);
    const commitIds = commitIdsByFileId.get(row.id);
    results.push({
      filePath: row.file_path,
      cosineSimilarity: fileSim,
      finalScore: score.finalScore,
      type: row.file_type,
      inProject: row.repo_id === currentRepoId,
      repoName: repoInfo?.name,
      repoPath: repoInfo?.rootPath,
      ...(score.normalizedBM25 > 0 && { keywordScore: score.normalizedBM25 }),
      ...(row.repo_id !== currentRepoId && { repoId: String(row.repo_id) }),
      ...(includeSkeleton && row.skeleton && { skeleton: row.skeleton }),
      ...(commitIds && commitIds.length > 0 && { commitIds }),
      ...(options.explain && {
        explanation: buildFileExplanation(fileSim, score, score.resolvedScoring),
      }),
    });
  }

  // --- Directory results ---
  for (const row of dirRows) {
    const concatSim = row.concat_distance != null ? 1 - row.concat_distance : 0;
    const summarySim = row.summary_distance != null ? 1 - row.summary_distance : 0;
    const dirKey = `${row.repo_id}:${row.dir_path}`;
    const finalScore = computeDirScore(
      concatSim,
      summarySim,
      childScoresByDir.get(dirKey) ?? [],
      gamma,
    );

    if (finalScore < minScore) continue;

    const repoInfo = repoInfoMap.get(row.repo_id);
    const baseSim = Math.max(concatSim, summarySim);
    results.push({
      filePath: row.dir_path,
      cosineSimilarity: baseSim,
      finalScore,
      type: "dir",
      inProject: row.repo_id === currentRepoId,
      repoName: repoInfo?.name,
      repoPath: repoInfo?.rootPath,
      ...(row.repo_id !== currentRepoId && { repoId: String(row.repo_id) }),
      ...(includeSummary && row.summary && { summary: row.summary }),
      ...(options.explain && { explanation: buildDirExplanation(baseSim, finalScore, scoring) }),
    });
  }

  // --- Commit results ---
  for (const row of commitRows) {
    const similarity = 1 - row.distance;
    if (similarity < minScore) continue;

    const repoInfo = repoInfoMap.get(row.repo_id);
    results.push({
      filePath: row.commit_hash,
      cosineSimilarity: similarity,
      finalScore: similarity,
      type: "commit",
      inProject: row.repo_id === currentRepoId,
      repoName: repoInfo?.name,
      repoPath: repoInfo?.rootPath,
      ...(row.repo_id !== currentRepoId && { repoId: String(row.repo_id) }),
    });
  }

  return results;
}
