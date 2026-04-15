// ---------------------------------------------------------------------------
// PostgreSQL search implementation
// ---------------------------------------------------------------------------

import path from "path";
import { withRepoScope } from "../db/rls";
import type { PgTx } from "../db/pg";
import type { SearchOptions, SearchResult, ScoringConfig } from "./types";
import type { PgFileRow, PgDirRow, PgCommitRow, PgFileLinkRow, PgRepoRow } from "./types-internal";
import { resolveLangExtensions, parseSince } from "./scope";
import {
  computeFileScore,
  computeDirScore,
  buildFileExplanation,
  buildDirExplanation,
} from "./scoring";
import { buildBM25Context, computeAvgTokenCount } from "./bm25-helpers";

export async function searchPg(
  repoIds: number[],
  currentRepoId: number,
  queryEmbedding: number[],
  query: string,
  options: Required<Omit<SearchOptions, "embeddingCache">>,
  scoring: ScoringConfig,
  languageProfiles?: Record<string, Partial<ScoringConfig>>,
  useBlobSchema: boolean = false,
): Promise<SearchResult[]> {
  // Use withRepoScope to pin to a single connection, set RLS scope, and
  // apply SET LOCAL hnsw.ef_search within the same transaction
  return withRepoScope(repoIds, async (tx) => {
    return await searchPgInTransaction(
      tx,
      repoIds,
      currentRepoId,
      queryEmbedding,
      query,
      options,
      scoring,
      languageProfiles,
      useBlobSchema,
    );
  });
}

/**
 * Pure: build the SQL + bind params for the junction-based file query
 * (`file_blobs` JOIN `repo_files`). HNSW scan happens on `fb.embedding`;
 * scope and dir/lang/since filters are applied on the junction join.
 *
 * Exported for unit testing.
 */
export function buildBlobFileQuery(args: {
  repoIds: number[];
  vecLiteral: string;
  langExts: string[] | null;
  dirFilters: string[] | null;
  sinceIso: string | null;
}): { sql: string; params: string[] } {
  const { repoIds, vecLiteral, langExts, dirFilters, sinceIso } = args;
  for (const id of repoIds) {
    if (typeof id !== "number" || !Number.isInteger(id)) {
      throw new Error(`Invalid repo ID: ${String(id)}`);
    }
  }
  const repoIdList = repoIds.join(",");
  const params: string[] = [];
  let paramIdx = 1;
  let filterSql = "";

  if (langExts && langExts.length > 0) {
    filterSql += ` AND fb.file_type IN (${langExts.map(() => `$${paramIdx++}`).join(",")})`;
    params.push(...langExts);
  }
  if (dirFilters && dirFilters.length > 0) {
    const dirConds = dirFilters.map(() => `rf.file_path LIKE $${paramIdx++}`).join(" OR ");
    filterSql += ` AND (${dirConds})`;
    params.push(...dirFilters.map((d) => `${d.replace(/\/$/, "")}/%`));
  }
  if (sinceIso) {
    // file_commits still references files.id during the dual-write window;
    // resolve via the legacy files table to preserve identical semantics
    // with the legacy query path (filter by commit authored_at, not by
    // repo_files.indexed_at).
    filterSql +=
      ` AND EXISTS (SELECT 1 FROM files f` +
      ` JOIN file_commits fc ON fc.file_id = f.id` +
      ` JOIN commits c ON c.id = fc.commit_id` +
      ` WHERE f.repo_id = rf.repo_id AND f.file_path = rf.file_path` +
      ` AND c.authored_at >= $${paramIdx++})`;
    params.push(sinceIso);
  }

  const sql =
    `SELECT rf.repo_id, rf.file_path, fb.skeleton, fb.file_type,` +
    ` 1 - (fb.embedding <=> ${vecLiteral}) AS similarity` +
    ` FROM file_blobs fb` +
    ` JOIN repo_files rf` +
    `   ON rf.content_hash = fb.content_hash` +
    `  AND rf.provider     = fb.provider` +
    `  AND rf.model        = fb.model` +
    `  AND rf.dimensions   = fb.dimensions` +
    ` WHERE rf.repo_id IN (${repoIdList}) AND fb.embedding IS NOT NULL${filterSql}`;

  return { sql, params };
}

export async function searchPgInTransaction(
  pg: PgTx,
  repoIds: number[],
  currentRepoId: number,
  queryEmbedding: number[],
  query: string,
  options: Required<Omit<SearchOptions, "embeddingCache">>,
  scoring: ScoringConfig,
  languageProfiles?: Record<string, Partial<ScoringConfig>>,
  useBlobSchema: boolean = false,
): Promise<SearchResult[]> {
  await pg.unsafe("SET LOCAL hnsw.ef_search = 40");

  // Defense-in-depth: validate interpolated values are strictly numeric
  // to prevent SQL injection even if upstream data is compromised.
  for (const v of queryEmbedding) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`Invalid embedding value: ${String(v)}`);
    }
  }
  for (const id of repoIds) {
    if (typeof id !== "number" || !Number.isInteger(id)) {
      throw new Error(`Invalid repo ID: ${String(id)}`);
    }
  }

  const vecLiteral = `'[${queryEmbedding.join(",")}]'::vector`;
  const repoIdList = repoIds.join(",");

  // Resolve scope filters
  const langExts =
    options.lang && options.lang.length > 0 ? resolveLangExtensions(options.lang) : null;
  const dirFilters = options.dir && options.dir.length > 0 ? options.dir : null;
  const sinceDate = options.since ? parseSince(options.since) : null;

  // --- Repo info map ---
  const repoInfoRows = (await pg.unsafe(
    `SELECT id, root_path, name FROM repos WHERE id IN (${repoIdList})`,
  )) as PgRepoRow[];
  const repoInfoMap = new Map<number, { name: string; rootPath: string }>();
  for (const r of repoInfoRows) {
    repoInfoMap.set(parseInt(r.id), { name: r.name, rootPath: r.root_path });
  }

  // --- Files ---
  let fileFilterSql = "";
  const fileFilterParams: string[] = [];
  let paramIdx = 1;

  if (langExts) {
    fileFilterSql += ` AND file_type IN (${langExts.map(() => `$${paramIdx++}`).join(",")})`;
    fileFilterParams.push(...langExts);
  }
  if (dirFilters) {
    const dirConds = dirFilters.map(() => `file_path LIKE $${paramIdx++}`).join(" OR ");
    fileFilterSql += ` AND (${dirConds})`;
    fileFilterParams.push(...dirFilters.map((d) => `${d.replace(/\/$/, "")}/%`));
  }
  if (sinceDate) {
    fileFilterSql += ` AND id IN (SELECT fc.file_id FROM file_commits fc JOIN commits c ON c.id = fc.commit_id WHERE c.authored_at >= $${paramIdx++})`;
    fileFilterParams.push(sinceDate.toISOString());
  }

  let fileRows: PgFileRow[];
  if (useBlobSchema) {
    const built = buildBlobFileQuery({
      repoIds,
      vecLiteral,
      langExts,
      dirFilters,
      sinceIso: sinceDate ? sinceDate.toISOString() : null,
    });
    const junctionRows = (await pg.unsafe(
      built.sql,
      built.params.length > 0 ? (built.params as never[]) : undefined,
    )) as Array<{
      repo_id: string;
      file_path: string;
      skeleton: string | null;
      file_type: string;
      similarity: string;
    }>;

    // file_commits still references files.id during the dual-write window,
    // so resolve a legacy id per (repo_id, file_path) for BM25 keying and
    // commit-boost lookup. Fall back to a synthetic key when no legacy row
    // exists (e.g. blob-only rows from a future migration).
    const idMap = new Map<string, string>();
    if (junctionRows.length > 0) {
      const repoIdArr = [...new Set(junctionRows.map((r) => parseInt(r.repo_id)))];
      const pathArr = [...new Set(junctionRows.map((r) => r.file_path))];
      // Avoid ANY($n) with array params — Bun.SQL misserialises nested
      // arrays, causing "number of array dimensions (N) exceeds maximum".
      // Use IN-list interpolation for validated integer repo IDs and
      // parameterised placeholders for file paths instead.
      for (const id of repoIdArr) {
        if (typeof id !== "number" || !Number.isInteger(id))
          throw new Error(`Invalid repo ID: ${String(id)}`);
      }
      const pathPlaceholders = pathArr.map((_, i) => `$${i + 1}`).join(",");
      const idRows = (await pg.unsafe(
        `SELECT id, repo_id, file_path FROM files
         WHERE repo_id IN (${repoIdArr.join(",")}) AND file_path IN (${pathPlaceholders})`,
        pathArr as never[],
      )) as { id: string; repo_id: string; file_path: string }[];
      for (const r of idRows) {
        idMap.set(`${r.repo_id}:${r.file_path}`, r.id);
      }
    }
    let synthCounter = -1;
    fileRows = junctionRows.map((r) => ({
      id: idMap.get(`${r.repo_id}:${r.file_path}`) ?? String(synthCounter--),
      repo_id: r.repo_id,
      file_path: r.file_path,
      skeleton: r.skeleton,
      file_type: r.file_type,
      similarity: r.similarity,
    }));
  } else {
    fileRows = (await pg.unsafe(
      `SELECT id, repo_id, file_path, skeleton, file_type,
              1 - (embedding <=> ${vecLiteral}) AS similarity
       FROM files
       WHERE repo_id IN (${repoIdList}) AND embedding IS NOT NULL${fileFilterSql}`,
      fileFilterParams.length > 0 ? (fileFilterParams as never[]) : undefined,
    )) as PgFileRow[];
  }

  // --- Directories ---
  let dirFilterSql = "";
  const dirFilterParams: unknown[] = [];
  let dirParamIdx = 1;

  if (dirFilters) {
    const dirConds = dirFilters
      .map(() => {
        const p1 = `$${dirParamIdx++}`;
        const p2 = `$${dirParamIdx++}`;
        return `(dir_path LIKE ${p1} OR dir_path = ${p2})`;
      })
      .join(" OR ");
    dirFilterSql += ` AND (${dirConds})`;
    dirFilterParams.push(
      ...dirFilters.flatMap((d) => {
        const clean = d.replace(/\/$/, "");
        return [`${clean}/%`, clean];
      }),
    );
  }

  const dirRows = (await pg.unsafe(
    `SELECT id, repo_id, dir_path, summary,
            1 - (concat_embedding <=> ${vecLiteral}) AS concat_sim,
            CASE WHEN summary_embedding IS NOT NULL
                 THEN 1 - (summary_embedding <=> ${vecLiteral})
                 ELSE 0
            END AS summary_sim
     FROM directories
     WHERE repo_id IN (${repoIdList}) AND concat_embedding IS NOT NULL${dirFilterSql}`,
    dirFilterParams.length > 0 ? (dirFilterParams as never[]) : undefined,
  )) as PgDirRow[];

  // --- Commits ---
  let commitFilterSql = "";
  const commitFilterParams: unknown[] = [];

  if (sinceDate) {
    commitFilterSql += ` AND authored_at >= $1`;
    commitFilterParams.push(sinceDate.toISOString());
  }

  const commitRows = (await pg.unsafe(
    `SELECT id, repo_id, commit_hash, message,
            1 - (embedding <=> ${vecLiteral}) AS similarity
     FROM commits
     WHERE repo_id IN (${repoIdList}) AND embedding IS NOT NULL${commitFilterSql}`,
    commitFilterParams.length > 0 ? (commitFilterParams as never[]) : undefined,
  )) as PgCommitRow[];

  // --- File-commit links for boost (limited to commitDepth) ---
  const linkRows = (await pg.unsafe(
    `SELECT fc.file_id, fc.commit_id, fc.recency,
            1 - (c.embedding <=> ${vecLiteral}) AS similarity
     FROM file_commits fc
     JOIN commits c ON c.id = fc.commit_id
     WHERE fc.file_id IN (
       SELECT id FROM files WHERE repo_id IN (${repoIdList}) AND embedding IS NOT NULL
     )
     AND fc.recency <= $1
     AND c.embedding IS NOT NULL`,
    [scoring.commitDepth] as never[],
  )) as PgFileLinkRow[];

  // Build dir similarity map: dir_path -> similarity
  const dirSimByPath = new Map<string, number>();
  const dirSummaryByPath = new Map<string, string | null>();
  for (const d of dirRows) {
    const concatSim = parseFloat(d.concat_sim);
    const summarySim = parseFloat(d.summary_sim);
    const sim = Math.max(concatSim, summarySim);
    dirSimByPath.set(`${d.repo_id}:${d.dir_path}`, sim);
    dirSummaryByPath.set(`${d.repo_id}:${d.dir_path}`, d.summary);
  }

  // Build commit link map and commit id set in a single pass
  const linksByFileId = new Map<number, Array<{ recency: number; similarity: number }>>();
  const commitIdsByFileId = new Map<number, string[]>();
  for (const link of linkRows) {
    const fileId = parseInt(link.file_id);
    const links = linksByFileId.get(fileId) ?? [];
    links.push({ recency: parseInt(link.recency), similarity: parseFloat(link.similarity) });
    linksByFileId.set(fileId, links);

    const ids = commitIdsByFileId.get(fileId) ?? [];
    ids.push(link.commit_id);
    commitIdsByFileId.set(fileId, ids);
  }

  const results: SearchResult[] = [];
  const { minScore, includeSkeleton, includeSummary } = options;
  const { gamma } = scoring;

  // Collect child file scores per directory for child-to-parent propagation
  const childScoresByDir = new Map<string, number[]>();

  // --- BM25 hybrid scoring ---
  const bm25Docs = fileRows.filter((r) => r.skeleton).map((r) => ({ id: r.id, text: r.skeleton! }));
  const bm25 = buildBM25Context(bm25Docs, query);
  const avgTokenCount = computeAvgTokenCount(fileRows);

  // --- File results ---
  for (const row of fileRows) {
    const fileId = parseInt(row.id);
    const repoId = parseInt(row.repo_id);
    const fileSim = parseFloat(row.similarity);
    const dirKey = `${row.repo_id}:${path.dirname(row.file_path)}`;

    const score = computeFileScore({
      fileSim,
      fileType: row.file_type,
      skeletonLength: row.skeleton?.length ?? 0,
      avgTokenCount,
      commitLinks: linksByFileId.get(fileId) ?? [],
      dirSim: dirSimByPath.get(dirKey) ?? 0,
      rawBM25: bm25.scores.get(row.id) ?? 0,
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

    const repoInfo = repoInfoMap.get(repoId);
    const commitIds = commitIdsByFileId.get(fileId);
    results.push({
      filePath: row.file_path,
      cosineSimilarity: fileSim,
      finalScore: score.finalScore,
      type: row.file_type,
      inProject: repoId === currentRepoId,
      repoName: repoInfo?.name,
      repoPath: repoInfo?.rootPath,
      ...(score.normalizedBM25 > 0 && { keywordScore: score.normalizedBM25 }),
      ...(repoId !== currentRepoId && { repoId: row.repo_id }),
      ...(includeSkeleton && row.skeleton && { skeleton: row.skeleton }),
      ...(commitIds && commitIds.length > 0 && { commitIds }),
      ...(options.explain && {
        explanation: buildFileExplanation(fileSim, score, score.resolvedScoring),
      }),
    });
  }

  // --- Directory results ---
  for (const row of dirRows) {
    const repoId = parseInt(row.repo_id);
    const concatSim = parseFloat(row.concat_sim);
    const summarySim = parseFloat(row.summary_sim);
    const dirKey = `${row.repo_id}:${row.dir_path}`;
    const finalScore = computeDirScore(
      concatSim,
      summarySim,
      childScoresByDir.get(dirKey) ?? [],
      gamma,
    );

    if (finalScore < minScore) continue;

    const repoInfo = repoInfoMap.get(repoId);
    const baseSim = Math.max(concatSim, summarySim);
    results.push({
      filePath: row.dir_path,
      cosineSimilarity: baseSim,
      finalScore,
      type: "dir",
      inProject: repoId === currentRepoId,
      repoName: repoInfo?.name,
      repoPath: repoInfo?.rootPath,
      ...(repoId !== currentRepoId && { repoId: row.repo_id }),
      ...(includeSummary && row.summary && { summary: row.summary }),
      ...(options.explain && { explanation: buildDirExplanation(baseSim, finalScore, scoring) }),
    });
  }

  // --- Commit results ---
  for (const row of commitRows) {
    const repoId = parseInt(row.repo_id);
    const similarity = parseFloat(row.similarity);
    if (similarity < minScore) continue;

    const repoInfo = repoInfoMap.get(repoId);
    results.push({
      filePath: row.commit_hash,
      cosineSimilarity: similarity,
      finalScore: similarity,
      type: "commit",
      inProject: repoId === currentRepoId,
      repoName: repoInfo?.name,
      repoPath: repoInfo?.rootPath,
      ...(repoId !== currentRepoId && { repoId: row.repo_id }),
    });
  }

  return results;
}
