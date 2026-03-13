import path from "path";
import { loadConfig } from "../config";
import { embedSingle } from "../index/embedder";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { serializeEmbedding } from "../db/util";
import type { SearchOptions, SearchResult, ScoringConfig, SkeletonEntry } from "./types";

// ---------------------------------------------------------------------------
// Internal row shapes returned by DB queries
// ---------------------------------------------------------------------------

interface PgFileRow {
  id: string;
  repo_id: string;
  file_path: string;
  skeleton: string | null;
  file_type: string;
  similarity: string;
}

interface PgDirRow {
  id: string;
  repo_id: string;
  dir_path: string;
  summary: string | null;
  concat_sim: string;
  summary_sim: string;
}

interface PgCommitRow {
  id: string;
  repo_id: string;
  commit_hash: string;
  message: string;
  similarity: string;
}

interface PgFileLinkRow {
  file_id: string;
  commit_id: string;
  recency: string;
  similarity: string;
}

interface PgRepoRow {
  id: string;
  root_path: string;
}

interface SqliteFileRow {
  id: number;
  repo_id: number;
  file_path: string;
  skeleton: string | null;
  file_type: string;
  distance: number;
}

interface SqliteDirRow {
  id: number;
  repo_id: number;
  dir_path: string;
  summary: string | null;
  concat_distance: number | null;
  summary_distance: number | null;
}

interface SqliteCommitRow {
  id: number;
  repo_id: number;
  commit_hash: string;
  message: string;
  distance: number;
}

interface SqliteFileLinkRow {
  file_id: number;
  commit_id: number;
  recency: number;
  distance: number;
}

interface SqliteRepoRow {
  id: number;
  root_path: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeCommitBoost(
  links: Array<{ recency: number; similarity: number }>,
  scoring: ScoringConfig,
): number {
  const { commitDecay, commitDepth } = scoring;
  let boost = 0;
  for (const link of links) {
    if (link.recency > commitDepth) continue;
    boost += link.similarity * Math.pow(1 - commitDecay, link.recency - 1);
  }
  return boost;
}

// ---------------------------------------------------------------------------
// PostgreSQL implementation
// ---------------------------------------------------------------------------

async function searchPg(
  repoIds: number[],
  currentRepoId: number,
  queryEmbedding: number[],
  options: Required<SearchOptions>,
  scoring: ScoringConfig,
): Promise<SearchResult[]> {
  const vecLiteral = `'[${queryEmbedding.join(",")}]'::vector`;
  const repoIdList = repoIds.join(",");

  // --- Files ---
  const fileRows = (await pgUnsafe(
    `SELECT id, repo_id, file_path, skeleton, file_type,
            1 - (embedding <=> ${vecLiteral}) AS similarity
     FROM files
     WHERE repo_id IN (${repoIdList}) AND embedding IS NOT NULL`,
  )) as PgFileRow[];

  // --- Directories ---
  const dirRows = (await pgUnsafe(
    `SELECT id, repo_id, dir_path, summary,
            1 - (concat_embedding <=> ${vecLiteral}) AS concat_sim,
            CASE WHEN summary_embedding IS NOT NULL
                 THEN 1 - (summary_embedding <=> ${vecLiteral})
                 ELSE 0
            END AS summary_sim
     FROM directories
     WHERE repo_id IN (${repoIdList}) AND concat_embedding IS NOT NULL`,
  )) as PgDirRow[];

  // --- Commits ---
  const commitRows = (await pgUnsafe(
    `SELECT id, repo_id, commit_hash, message,
            1 - (embedding <=> ${vecLiteral}) AS similarity
     FROM commits
     WHERE repo_id IN (${repoIdList}) AND embedding IS NOT NULL`,
  )) as PgCommitRow[];

  // --- File–commit links for boost (limited to commitDepth) ---
  const linkRows = (await pgUnsafe(
    `SELECT fc.file_id, fc.commit_id, fc.recency,
            1 - (c.embedding <=> ${vecLiteral}) AS similarity
     FROM file_commits fc
     JOIN commits c ON c.id = fc.commit_id
     WHERE fc.file_id IN (
       SELECT id FROM files WHERE repo_id IN (${repoIdList}) AND embedding IS NOT NULL
     )
     AND fc.recency <= $1
     AND c.embedding IS NOT NULL`,
    [scoring.commitDepth],
  )) as PgFileLinkRow[];

  // Build dir similarity map: dir_path -> similarity
  const dirSimByPath = new Map<string, number>();
  const dirRepoByPath = new Map<string, number>();
  const dirSummaryByPath = new Map<string, string | null>();
  for (const d of dirRows) {
    const concatSim = parseFloat(d.concat_sim);
    const summarySim = parseFloat(d.summary_sim);
    const sim = Math.max(concatSim, summarySim);
    dirSimByPath.set(`${d.repo_id}:${d.dir_path}`, sim);
    dirRepoByPath.set(`${d.repo_id}:${d.dir_path}`, parseInt(d.repo_id));
    dirSummaryByPath.set(`${d.repo_id}:${d.dir_path}`, d.summary);
  }

  // Build commit link map: file_id -> links[]
  const linksByFileId = new Map<number, Array<{ recency: number; similarity: number }>>();
  for (const link of linkRows) {
    const fileId = parseInt(link.file_id);
    const links = linksByFileId.get(fileId) ?? [];
    links.push({ recency: parseInt(link.recency), similarity: parseFloat(link.similarity) });
    linksByFileId.set(fileId, links);
  }

  // Build commit id set by file
  const commitIdsByFileId = new Map<number, string[]>();
  for (const link of linkRows) {
    const fileId = parseInt(link.file_id);
    const ids = commitIdsByFileId.get(fileId) ?? [];
    ids.push(link.commit_id);
    commitIdsByFileId.set(fileId, ids);
  }

  const results: SearchResult[] = [];
  const { minScore, includeSkeleton, includeSummary } = options;
  const { alpha, beta, gamma } = scoring;

  // Collect child file scores per directory for child-to-parent propagation
  const childScoresByDir = new Map<string, number[]>();

  // --- File results ---
  for (const row of fileRows) {
    const fileId = parseInt(row.id);
    const repoId = parseInt(row.repo_id);
    const fileSim = parseFloat(row.similarity);
    const links = linksByFileId.get(fileId) ?? [];
    const commitBoost = computeCommitBoost(links, scoring);

    const parentDir = path.dirname(row.file_path);
    const dirKey = `${row.repo_id}:${parentDir}`;
    const dirSim = dirSimByPath.get(dirKey) ?? 0;
    const parentBoost = dirSim > minScore ? scoring.parentBoostMultiplier * dirSim : 0;

    const finalScore = fileSim + alpha * commitBoost + beta * parentBoost;
    if (finalScore >= minScore) {
      // Track child scores for parent directory boosting
      const scores = childScoresByDir.get(dirKey) ?? [];
      scores.push(finalScore);
      childScoresByDir.set(dirKey, scores);
    }
    if (finalScore < minScore) continue;

    const result: SearchResult = {
      filePath: row.file_path,
      cosineSimilarity: fileSim,
      finalScore,
      type: row.file_type,
      inProject: repoId === currentRepoId,
    };
    if (repoId !== currentRepoId) result.repoId = row.repo_id;
    if (includeSkeleton && row.skeleton) result.skeleton = row.skeleton;
    const commitIds = commitIdsByFileId.get(fileId);
    if (commitIds && commitIds.length > 0) result.commitIds = commitIds;
    results.push(result);
  }

  // --- Directory results ---
  for (const row of dirRows) {
    const repoId = parseInt(row.repo_id);
    const concatSim = parseFloat(row.concat_sim);
    const summarySim = parseFloat(row.summary_sim);
    let finalScore = Math.max(concatSim, summarySim);

    // Child-to-parent boost: if >= 2 child files scored above minScore,
    // boost directory by gamma * AVG(top child scores)
    const dirKey = `${row.repo_id}:${row.dir_path}`;
    const childScores = childScoresByDir.get(dirKey) ?? [];
    if (childScores.length >= 2) {
      const avg = childScores.reduce((a, b) => a + b, 0) / childScores.length;
      finalScore += gamma * avg;
    }

    if (finalScore < minScore) continue;

    const result: SearchResult = {
      filePath: row.dir_path,
      cosineSimilarity: Math.max(concatSim, summarySim),
      finalScore,
      type: "dir",
      inProject: repoId === currentRepoId,
    };
    if (repoId !== currentRepoId) result.repoId = row.repo_id;
    if (includeSummary && row.summary) result.summary = row.summary;
    results.push(result);
  }

  // --- Commit results ---
  for (const row of commitRows) {
    const repoId = parseInt(row.repo_id);
    const similarity = parseFloat(row.similarity);
    if (similarity < minScore) continue;

    const result: SearchResult = {
      filePath: row.commit_hash,
      cosineSimilarity: similarity,
      finalScore: similarity,
      type: "commit",
      inProject: repoId === currentRepoId,
    };
    if (repoId !== currentRepoId) result.repoId = row.repo_id;
    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

async function searchSqlite(
  repoIds: number[],
  currentRepoId: number,
  repoRoot: string,
  queryEmbedding: number[],
  options: Required<SearchOptions>,
  scoring: ScoringConfig,
): Promise<SearchResult[]> {
  const db = await getSqlite(repoRoot);
  const embBuf = serializeEmbedding(queryEmbedding);
  const repoIdList = repoIds.join(",");

  // --- Files ---
  const fileRows = db
    .prepare(
      `SELECT f.id, f.repo_id, f.file_path, f.skeleton, f.file_type,
              vec_distance_cosine(fe.embedding, ?) AS distance
       FROM files f
       JOIN file_embeddings fe ON f.id = fe.file_id
       WHERE f.repo_id IN (${repoIdList})`,
    )
    .all(embBuf) as SqliteFileRow[];

  // --- Directories ---
  const dirRows = db
    .prepare(
      `SELECT d.id, d.repo_id, d.dir_path, d.summary,
              vec_distance_cosine(dce.embedding, ?) AS concat_distance,
              CASE WHEN dse.embedding IS NOT NULL
                   THEN vec_distance_cosine(dse.embedding, ?)
                   ELSE NULL
              END AS summary_distance
       FROM directories d
       LEFT JOIN dir_concat_embeddings dce ON d.id = dce.dir_id
       LEFT JOIN dir_summary_embeddings dse ON d.id = dse.dir_id
       WHERE d.repo_id IN (${repoIdList}) AND dce.embedding IS NOT NULL`,
    )
    .all(embBuf, embBuf) as SqliteDirRow[];

  // --- Commits ---
  const commitRows = db
    .prepare(
      `SELECT c.id, c.repo_id, c.commit_hash, c.message,
              vec_distance_cosine(ce.embedding, ?) AS distance
       FROM commits c
       JOIN commit_embeddings ce ON c.id = ce.commit_id
       WHERE c.repo_id IN (${repoIdList})`,
    )
    .all(embBuf) as SqliteCommitRow[];

  // --- File–commit links ---
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
  const { alpha, beta, gamma } = scoring;

  // Collect child file scores per directory for child-to-parent propagation
  const childScoresByDir = new Map<string, number[]>();

  // --- File results ---
  for (const row of fileRows) {
    const fileSim = 1 - row.distance;
    const links = linksByFileId.get(row.id) ?? [];
    const commitBoost = computeCommitBoost(links, scoring);

    const parentDir = path.dirname(row.file_path);
    const dirKey = `${row.repo_id}:${parentDir}`;
    const dirSim = dirSimByPath.get(dirKey) ?? 0;
    const parentBoost = dirSim > minScore ? scoring.parentBoostMultiplier * dirSim : 0;

    const finalScore = fileSim + alpha * commitBoost + beta * parentBoost;
    if (finalScore >= minScore) {
      const scores = childScoresByDir.get(dirKey) ?? [];
      scores.push(finalScore);
      childScoresByDir.set(dirKey, scores);
    }
    if (finalScore < minScore) continue;

    const result: SearchResult = {
      filePath: row.file_path,
      cosineSimilarity: fileSim,
      finalScore,
      type: row.file_type,
      inProject: row.repo_id === currentRepoId,
    };
    if (row.repo_id !== currentRepoId) result.repoId = String(row.repo_id);
    if (includeSkeleton && row.skeleton) result.skeleton = row.skeleton;
    const commitIds = commitIdsByFileId.get(row.id);
    if (commitIds && commitIds.length > 0) result.commitIds = commitIds;
    results.push(result);
  }

  // --- Directory results ---
  for (const row of dirRows) {
    const concatSim = row.concat_distance != null ? 1 - row.concat_distance : 0;
    const summarySim = row.summary_distance != null ? 1 - row.summary_distance : 0;
    let finalScore = Math.max(concatSim, summarySim);

    // Child-to-parent boost: if >= 2 child files scored above minScore,
    // boost directory by gamma * AVG(top child scores)
    const dirKey = `${row.repo_id}:${row.dir_path}`;
    const childScores = childScoresByDir.get(dirKey) ?? [];
    if (childScores.length >= 2) {
      const avg = childScores.reduce((a, b) => a + b, 0) / childScores.length;
      finalScore += gamma * avg;
    }

    if (finalScore < minScore) continue;

    const result: SearchResult = {
      filePath: row.dir_path,
      cosineSimilarity: Math.max(concatSim, summarySim),
      finalScore,
      type: "dir",
      inProject: row.repo_id === currentRepoId,
    };
    if (row.repo_id !== currentRepoId) result.repoId = String(row.repo_id);
    if (includeSummary && row.summary) result.summary = row.summary;
    results.push(result);
  }

  // --- Commit results ---
  for (const row of commitRows) {
    const similarity = 1 - row.distance;
    if (similarity < minScore) continue;

    const result: SearchResult = {
      filePath: row.commit_hash,
      cosineSimilarity: similarity,
      finalScore: similarity,
      type: "commit",
      inProject: row.repo_id === currentRepoId,
    };
    if (row.repo_id !== currentRepoId) result.repoId = String(row.repo_id);
    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Repo resolution
// ---------------------------------------------------------------------------

async function resolveRepoIds(
  repoRoot: string,
  scope: SearchOptions["scope"],
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<{ repoIds: number[]; currentRepoId: number }> {
  if (config.store === "pg") {
    const repos = (await pgUnsafe(`SELECT id, root_path FROM repos`)) as PgRepoRow[];

    const currentRepo = repos.find((r) => r.root_path === repoRoot);
    const currentRepoId = currentRepo ? parseInt(currentRepo.id) : -1;

    if (scope === "all") {
      return { repoIds: repos.map((r) => parseInt(r.id)), currentRepoId };
    }
    if (Array.isArray(scope)) {
      const filtered = repos.filter((r) => scope.includes(r.root_path)).map((r) => parseInt(r.id));
      return { repoIds: filtered.length > 0 ? filtered : [currentRepoId], currentRepoId };
    }
    // "project" or undefined
    return { repoIds: currentRepoId !== -1 ? [currentRepoId] : [], currentRepoId };
  } else {
    const db = await getSqlite(repoRoot);
    const repos = db.prepare(`SELECT id, root_path FROM repos`).all() as SqliteRepoRow[];

    const currentRepo = repos.find((r) => r.root_path === repoRoot);
    const currentRepoId = currentRepo ? currentRepo.id : -1;

    if (scope === "all") {
      return { repoIds: repos.map((r) => r.id), currentRepoId };
    }
    if (Array.isArray(scope)) {
      const filtered = repos.filter((r) => scope.includes(r.root_path)).map((r) => r.id);
      return { repoIds: filtered.length > 0 ? filtered : [currentRepoId], currentRepoId };
    }
    return { repoIds: currentRepoId !== -1 ? [currentRepoId] : [], currentRepoId };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Main semantic search function. Searches files, directories, and commits
 * using cosine similarity of embeddings, applying the commit-boost and
 * parent-directory-boost scoring formula from the spec.
 */
export async function search(
  repoRoot: string,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const config = await loadConfig(repoRoot);
  const scoring: ScoringConfig = options?.scoringOverrides
    ? { ...config.scoring, ...options.scoringOverrides }
    : config.scoring;

  const resolvedOptions: Required<SearchOptions> = {
    minScore: options?.minScore ?? scoring.minScore,
    topN: options?.topN ?? 0,
    scope: options?.scope ?? "project",
    includeSkeleton: options?.includeSkeleton ?? false,
    includeSummary: options?.includeSummary ?? false,
    includeSnippet: options?.includeSnippet ?? false,
    scoringOverrides: options?.scoringOverrides ?? {},
  };

  const queryEmbedding = await embedSingle(query);
  const { repoIds, currentRepoId } = await resolveRepoIds(repoRoot, resolvedOptions.scope, config);

  if (repoIds.length === 0) {
    return [];
  }

  let results: SearchResult[];

  if (config.store === "pg") {
    results = await searchPg(repoIds, currentRepoId, queryEmbedding, resolvedOptions, scoring);
  } else {
    results = await searchSqlite(
      repoIds,
      currentRepoId,
      repoRoot,
      queryEmbedding,
      resolvedOptions,
      scoring,
    );
  }

  results.sort((a, b) => b.finalScore - a.finalScore);

  const finalResults = resolvedOptions.topN > 0 ? results.slice(0, resolvedOptions.topN) : results;

  // Post-processing: attach snippets if requested
  if (resolvedOptions.includeSnippet) {
    await attachSnippets(repoRoot, config, finalResults, query);
  }

  return finalResults;
}

// ---------------------------------------------------------------------------
// Snippet post-processing
// ---------------------------------------------------------------------------

async function attachSnippets(
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  results: SearchResult[],
  query: string,
): Promise<void> {
  const queryWords = new Set(query.toLowerCase().split(/\s+/).filter((w) => w.length > 2));

  for (const result of results) {
    if (result.type === "dir" || result.type === "commit") continue;

    // Load skeleton_entries from DB
    let entriesJson: string | null = null;
    if (config.store === "pg") {
      const rows = await pgUnsafe(
        "SELECT skeleton_entries FROM files WHERE repo_id IN (SELECT id FROM repos WHERE root_path = $1) AND file_path = $2",
        [repoRoot, result.filePath],
      );
      if (rows.length > 0) entriesJson = rows[0].skeleton_entries as string | null;
    } else {
      const db = await getSqlite(repoRoot);
      const rows = db
        .prepare(
          `SELECT f.skeleton_entries FROM files f
           JOIN repos r ON r.id = f.repo_id
           WHERE r.root_path = ? AND f.file_path = ?`,
        )
        .all(repoRoot, result.filePath) as { skeleton_entries: string | null }[];
      if (rows.length > 0) entriesJson = rows[0].skeleton_entries;
    }

    if (!entriesJson) continue;

    let entries: SkeletonEntry[];
    try {
      entries = JSON.parse(entriesJson);
    } catch {
      continue;
    }
    if (!entries || entries.length === 0) continue;

    // Find best-matching entry via word-intersection score
    let bestEntry: SkeletonEntry | null = null;
    let bestScore = -1;
    for (const entry of entries) {
      const nameWords = entry.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const kindWords = entry.kind.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const allWords = [...nameWords, ...kindWords];
      let score = 0;
      for (const w of allWords) {
        if (queryWords.has(w)) score++;
        // Partial match bonus
        for (const qw of queryWords) {
          if (w.includes(qw) || qw.includes(w)) score += 0.5;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    // Fallback to first entry if no match
    if (!bestEntry) bestEntry = entries[0];

    result.lineStart = bestEntry.startLine;
    result.lineEnd = bestEntry.endLine;

    // Read source file and extract lines (cap at 20)
    try {
      const absPath = `${repoRoot}/${result.filePath}`;
      const content = await Bun.file(absPath).text();
      const lines = content.split("\n");
      const start = bestEntry.startLine - 1; // 0-indexed
      const maxLines = 20;
      const end = Math.min(bestEntry.endLine, start + maxLines);
      result.snippet = lines.slice(start, end).join("\n");
    } catch {
      // File might not exist on disk
    }
  }
}

/**
 * Convenience wrapper — returns only file-type results (excludes "dir" and "commit").
 */
export async function searchFiles(
  repoRoot: string,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const all = await search(repoRoot, query, options);
  return all.filter((r) => r.type !== "dir" && r.type !== "commit");
}

/**
 * Convenience wrapper — returns only directory results.
 */
export async function searchDirectories(
  repoRoot: string,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const all = await search(repoRoot, query, options);
  return all.filter((r) => r.type === "dir");
}

/**
 * Convenience wrapper — returns only commit results.
 */
export async function searchCommits(
  repoRoot: string,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const all = await search(repoRoot, query, options);
  return all.filter((r) => r.type === "commit");
}
