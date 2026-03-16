// ---------------------------------------------------------------------------
// PostgreSQL search implementation
// ---------------------------------------------------------------------------

import path from "path";
import { withRepoScope } from "../db/rls";
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
    );
  });
}

export async function searchPgInTransaction(
  pg: InstanceType<typeof import("bun").SQL>,
  repoIds: number[],
  currentRepoId: number,
  queryEmbedding: number[],
  query: string,
  options: Required<Omit<SearchOptions, "embeddingCache">>,
  scoring: ScoringConfig,
  languageProfiles?: Record<string, Partial<ScoringConfig>>,
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

  const fileRows = (await pg.unsafe(
    `SELECT id, repo_id, file_path, skeleton, file_type,
            1 - (embedding <=> ${vecLiteral}) AS similarity
     FROM files
     WHERE repo_id IN (${repoIdList}) AND embedding IS NOT NULL${fileFilterSql}`,
    fileFilterParams.length > 0 ? (fileFilterParams as never[]) : undefined,
  )) as PgFileRow[];

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
