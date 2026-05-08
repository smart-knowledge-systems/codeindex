import { loadConfig } from "../config";
import { embedSingle } from "@easier-idx/embedding";
import { getProvider } from "../embedding-provider";
import { pgUnsafe } from "../db/pg";
import { withRepoScope } from "../db/rls";
import { getSqlite } from "../db/sqlite";
import type { SearchOptions, SearchResult, SkeletonEntry } from "./types";
import { getScopedRepoIds } from "../auth/tokens";
import { logEvent, getSessionId } from "../logging";
import { recordEvent, hashQuery } from "../telemetry";
import { rerank } from "./rerank";
import { expandQuery } from "@easier-idx/core";
import { searchPg } from "./search-pg";
import { searchSqlite } from "./search-sqlite";
import { resolveRepoIds, resolveSearchOptions, resolveScoring } from "./resolve";

// ---------------------------------------------------------------------------
// Snippet post-processing — impure shell (I/O) wrapping pure matching
// ---------------------------------------------------------------------------

/** Pure: find the best-matching skeleton entry for a given set of query words. */
function findBestEntry(
  entries: readonly SkeletonEntry[],
  queryWords: ReadonlySet<string>,
): SkeletonEntry {
  let bestEntry: SkeletonEntry = entries[0];
  let bestScore = -1;
  for (const entry of entries) {
    const nameWords = entry.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
    const kindWords = entry.kind
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
    const allWords = [...nameWords, ...kindWords];
    let score = 0;
    for (const w of allWords) {
      if (queryWords.has(w)) score++;
      for (const qw of queryWords) {
        if (w.includes(qw) || qw.includes(w)) score += 0.5;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }
  return bestEntry;
}

/** Pure: extract a capped snippet from file content at given line range. */
function extractSnippet(
  content: string,
  startLine: number,
  endLine: number,
  maxLines = 20,
): string {
  const lines = content.split("\n");
  const start = startLine - 1; // 0-indexed
  const end = Math.min(endLine, start + maxLines);
  return lines.slice(start, end).join("\n");
}

/**
 * Impure shell: fetch skeleton entries from DB, read files from disk,
 * and return a new results array with snippets attached.
 */
async function withSnippets(
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  results: readonly SearchResult[],
  query: string,
  currentRepoId: number,
): Promise<SearchResult[]> {
  const queryWords = new Set(
    query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

  // Batch load skeleton_entries for all file results in a single query
  const fileResults = results.filter((r) => r.type !== "dir" && r.type !== "commit");
  const filePaths = fileResults.map((r) => r.filePath);
  const resultRepoIds = [
    ...new Set(
      fileResults
        .map((r) => (r.repoId ? parseInt(r.repoId) : currentRepoId))
        .filter((id) => !isNaN(id)),
    ),
  ];
  // Key by repo_id:file_path to avoid collisions across repos with identical relative paths
  const entriesMap = new Map<string, string>();

  if (filePaths.length > 0) {
    if (config.store === "pg") {
      const rows = await withRepoScope(resultRepoIds, async (tx) => {
        const repoPlaceholders = resultRepoIds.map((_, i) => `$${i + 1}`).join(",");
        const pathPlaceholders = filePaths
          .map((_, i) => `$${resultRepoIds.length + i + 1}`)
          .join(",");
        return (await tx.unsafe(
          `SELECT repo_id, file_path, skeleton_entries FROM files
           WHERE repo_id IN (${repoPlaceholders})
           AND file_path IN (${pathPlaceholders})`,
          [...resultRepoIds, ...filePaths],
        )) as { repo_id: string; file_path: string; skeleton_entries: string | null }[];
      });
      for (const row of rows) {
        if (row.skeleton_entries)
          entriesMap.set(`${row.repo_id}:${row.file_path}`, row.skeleton_entries);
      }
    } else {
      const db = await getSqlite(repoRoot);
      const pathPlaceholders = filePaths.map(() => "?").join(",");
      const repoPlaceholders = resultRepoIds.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT f.repo_id, f.file_path, f.skeleton_entries FROM files f
           WHERE f.repo_id IN (${repoPlaceholders}) AND f.file_path IN (${pathPlaceholders})`,
        )
        .all(...resultRepoIds, ...filePaths) as {
        repo_id: number;
        file_path: string;
        skeleton_entries: string | null;
      }[];
      for (const row of rows) {
        if (row.skeleton_entries)
          entriesMap.set(`${row.repo_id}:${row.file_path}`, row.skeleton_entries);
      }
    }
  }

  // Read file contents in parallel for snippet extraction
  const fileContentCache = new Map<string, string>();
  await Promise.all(
    fileResults.map(async (result) => {
      try {
        const absPath = `${repoRoot}/${result.filePath}`;
        const content = await Bun.file(absPath).text();
        fileContentCache.set(result.filePath, content);
      } catch {
        // File might not exist on disk
      }
    }),
  );

  // Build new results with snippets (pure transformation over fetched data)
  return results.map((result) => {
    if (result.type === "dir" || result.type === "commit") return result;

    const repoId = result.repoId ? parseInt(result.repoId) : currentRepoId;
    const entriesJson = entriesMap.get(`${repoId}:${result.filePath}`);
    if (!entriesJson) return result;

    let entries: SkeletonEntry[];
    try {
      entries = JSON.parse(entriesJson);
    } catch {
      return result;
    }
    if (!entries || entries.length === 0) return result;

    const bestEntry = findBestEntry(entries, queryWords);
    const content = fileContentCache.get(result.filePath);
    return {
      ...result,
      lineStart: bestEntry.startLine,
      lineEnd: bestEntry.endLine,
      ...(content !== undefined && {
        snippet: extractSnippet(content, bestEntry.startLine, bestEntry.endLine),
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Cross-repo edge post-processing
// ---------------------------------------------------------------------------

/** Pure: annotate results with cross-repo edge data from a pre-fetched deps map. */
function annotateWithEdges(
  results: readonly SearchResult[],
  depsByRepo: ReadonlyMap<
    number,
    ReadonlyArray<{ repoName: string; direction: "depends-on" | "depended-by" }>
  >,
  currentRepoId: number,
): SearchResult[] {
  return results.map((result) => {
    if (result.type === "commit" || result.type === "dir") return result;
    const repoId = result.repoId ? parseInt(result.repoId) : currentRepoId;
    const edges = depsByRepo.get(repoId);
    if (edges && edges.length > 0) return { ...result, crossRepoEdges: [...edges] };
    return result;
  });
}

/**
 * Impure shell: fetch cross-repo edges from DB and return a new results array
 * with edges annotated on file results.
 */
async function withCrossRepoEdges(
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  results: readonly SearchResult[],
  currentRepoId: number,
  scopedRepoIds: number[] | null = null,
): Promise<SearchResult[]> {
  // Build repo name map
  const repoNameMap = new Map<number, string>();
  if (config.store === "pg") {
    const repos = (await pgUnsafe("SELECT id, name FROM repos")) as {
      id: string;
      name: string;
    }[];
    for (const r of repos) repoNameMap.set(parseInt(r.id), r.name);

    // Build cross-repo edges lookup, filtered by scoped repo IDs if present
    // Wrap in withRepoScope so FORCE RLS on cross_repo_edges passes
    const edgeRepoIds = scopedRepoIds ?? [...repoNameMap.keys()];
    let edgeQuery = `SELECT DISTINCT source_repo_id, target_repo_id FROM cross_repo_edges`;
    const edgeParams: unknown[] = [];
    if (scopedRepoIds !== null && scopedRepoIds.length > 0) {
      const placeholders = scopedRepoIds.map((_, i) => `$${i + 1}`).join(",");
      const placeholders2 = scopedRepoIds
        .map((_, i) => `$${i + 1 + scopedRepoIds.length}`)
        .join(",");
      edgeQuery += ` WHERE (source_repo_id IN (${placeholders}) OR target_repo_id IN (${placeholders2}))`;
      edgeParams.push(...scopedRepoIds, ...scopedRepoIds);
    }
    const allEdges = await withRepoScope(edgeRepoIds, async (tx) => {
      return (await tx.unsafe(edgeQuery, edgeParams)) as {
        source_repo_id: string;
        target_repo_id: string;
      }[];
    });

    const depsByRepo = new Map<
      number,
      Array<{ repoName: string; direction: "depends-on" | "depended-by" }>
    >();
    for (const e of allEdges) {
      const srcId = parseInt(e.source_repo_id);
      const tgtId = parseInt(e.target_repo_id);

      const sourceList = depsByRepo.get(srcId) ?? [];
      const targetName = repoNameMap.get(tgtId) ?? `repo:${tgtId}`;
      sourceList.push({ repoName: targetName, direction: "depends-on" });
      depsByRepo.set(srcId, sourceList);

      const targetList = depsByRepo.get(tgtId) ?? [];
      const sourceName = repoNameMap.get(srcId) ?? `repo:${srcId}`;
      targetList.push({ repoName: sourceName, direction: "depended-by" });
      depsByRepo.set(tgtId, targetList);
    }

    return annotateWithEdges(results, depsByRepo, currentRepoId);
  } else {
    const db = await getSqlite(repoRoot);
    const repos = db.prepare("SELECT id, name FROM repos").all() as {
      id: number;
      name: string;
    }[];
    for (const r of repos) repoNameMap.set(r.id, r.name);

    // Build cross-repo edges lookup, filtered by scoped repo IDs if present
    let edgeQuery = `SELECT source_repo_id, target_repo_id FROM cross_repo_edges`;
    const edgeBindings: number[] = [];
    if (scopedRepoIds !== null && scopedRepoIds.length > 0) {
      const placeholders = scopedRepoIds.map(() => "?").join(",");
      edgeQuery += ` WHERE (source_repo_id IN (${placeholders}) OR target_repo_id IN (${placeholders}))`;
      edgeBindings.push(...scopedRepoIds, ...scopedRepoIds);
    }
    edgeQuery += ` GROUP BY source_repo_id, target_repo_id`;
    const allEdges = db.prepare(edgeQuery).all(...edgeBindings) as {
      source_repo_id: number;
      target_repo_id: number;
    }[];

    const depsByRepo = new Map<
      number,
      Array<{ repoName: string; direction: "depends-on" | "depended-by" }>
    >();
    for (const e of allEdges) {
      const sourceList = depsByRepo.get(e.source_repo_id) ?? [];
      const targetName = repoNameMap.get(e.target_repo_id) ?? `repo:${e.target_repo_id}`;
      sourceList.push({ repoName: targetName, direction: "depends-on" });
      depsByRepo.set(e.source_repo_id, sourceList);

      const targetList = depsByRepo.get(e.target_repo_id) ?? [];
      const sourceName = repoNameMap.get(e.source_repo_id) ?? `repo:${e.source_repo_id}`;
      targetList.push({ repoName: sourceName, direction: "depended-by" });
      depsByRepo.set(e.target_repo_id, targetList);
    }

    return annotateWithEdges(results, depsByRepo, currentRepoId);
  }
}

// ---------------------------------------------------------------------------
// Changed-file search — files indexed after a given timestamp
// ---------------------------------------------------------------------------

function parseSinceTimestamp(since: string): Date {
  // Relative formats: "1d", "7d", "2w", "3m"
  const relMatch = since.match(/^(\d+)([dwm])$/);
  if (relMatch) {
    const n = parseInt(relMatch[1]);
    const unit = relMatch[2];
    const now = new Date();
    switch (unit) {
      case "d":
        now.setDate(now.getDate() - n);
        break;
      case "w":
        now.setDate(now.getDate() - n * 7);
        break;
      case "m": {
        const day = now.getDate();
        now.setDate(1); // pin to 1st to avoid overflow
        now.setMonth(now.getMonth() - n);
        // Restore original day, clamped to end of target month
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        now.setDate(Math.min(day, lastDay));
        break;
      }
    }
    return now;
  }
  // ISO date string
  const d = new Date(since);
  if (isNaN(d.getTime())) throw new Error(`Invalid since value: ${since}`);
  return d;
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
  const startTime = performance.now();
  const config = await loadConfig(repoRoot);

  // Resolve scoring and options via pure pipeline
  const provider = config.embedding.provider;
  const scoring = resolveScoring(
    config.scoring,
    config.providerProfiles?.[provider] ?? {},
    options?.scoringOverrides ?? {},
  );
  const resolvedOptions = resolveSearchOptions(options, scoring);

  // Expand query for local embedding providers to improve match quality
  const effectiveQuery = provider === "ollama" ? expandQuery(query) : query;

  let queryEmbedding: number[];
  const cached = options?.embeddingCache?.get(effectiveQuery);
  if (cached) {
    queryEmbedding = cached;
  } else {
    queryEmbedding = await embedSingle(getProvider(config), effectiveQuery);
    options?.embeddingCache?.set(effectiveQuery, queryEmbedding);
  }
  const resolved = await resolveRepoIds(repoRoot, resolvedOptions.scope, config);
  let repoIds = resolved.repoIds;
  const currentRepoId = resolved.currentRepoId;

  // Apply token-based repo scoping if CODEINDEX_TOKEN is set
  const tokenRepoIds = await getScopedRepoIds(repoRoot);
  if (tokenRepoIds !== null) {
    const allowed = new Set(tokenRepoIds);
    repoIds = repoIds.filter((id) => allowed.has(id));
  }

  if (repoIds.length === 0) {
    return [];
  }

  let results: SearchResult[];

  if (config.store === "pg") {
    results = await searchPg(
      repoIds,
      currentRepoId,
      queryEmbedding,
      query,
      resolvedOptions,
      scoring,
      config.languageProfiles,
      config.search?.useBlobSchema ?? false,
    );
  } else {
    results = await searchSqlite(
      repoIds,
      currentRepoId,
      repoRoot,
      queryEmbedding,
      query,
      resolvedOptions,
      scoring,
      config.languageProfiles,
      config.search?.useBlobSchema ?? false,
    );
  }

  results.sort((a, b) => b.finalScore - a.finalScore);

  // Apply lightweight re-ranking if enabled
  if (config.reranking?.enabled) {
    const rerankCandidates = results.slice(0, 50);
    const reranked = await rerank(rerankCandidates, {
      store: config.store,
      repoRoot,
      repoIds,
      reranking: config.reranking,
    });
    results = [...reranked, ...results.slice(50)];
    results.sort((a, b) => b.finalScore - a.finalScore);
  }

  let finalResults = resolvedOptions.topN > 0 ? results.slice(0, resolvedOptions.topN) : results;

  // Post-processing pipeline: each step returns a new array (no mutation)
  if (resolvedOptions.includeSnippet) {
    finalResults = await withSnippets(repoRoot, config, finalResults, query, currentRepoId);
  }
  if (repoIds.length > 1) {
    finalResults = await withCrossRepoEdges(
      repoRoot,
      config,
      finalResults,
      currentRepoId,
      tokenRepoIds,
    );
  }

  // Single wide event: all context in one structured log (Issues 1, 5, 6, 7)
  const duration_ms = Math.round(performance.now() - startTime);
  const queryHash = hashQuery(query);

  logEvent({
    event: "search.query.complete",
    query_length: query.length,
    query_hash: queryHash,
    result_count: finalResults.length,
    duration_ms,
    sessionId: getSessionId(),
  });

  recordEvent({
    event: "search",
    timestamp: new Date().toISOString(),
    sessionId: getSessionId(),
    queryHash,
    resultCount: finalResults.length,
    duration_ms,
  });

  return finalResults;
}

export async function searchChanged(
  repoRoot: string,
  since: string,
  query?: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const config = await loadConfig(repoRoot);
  const sinceDate = parseSinceTimestamp(since);
  const sinceIso = sinceDate.toISOString();

  // Get the repo ID
  const resolved = await resolveRepoIds(repoRoot, options?.scope ?? "project", config);
  const repoIds = resolved.repoIds;
  if (repoIds.length === 0) return [];

  // Query files changed since the timestamp
  const changedPaths = new Set<string>();

  if (config.store === "pg") {
    const placeholders = repoIds.map((_, i) => `$${i + 2}`).join(",");
    const rows = await withRepoScope(repoIds, async (tx) => {
      return (await tx.unsafe(
        `SELECT file_path FROM files
         WHERE repo_id IN (${placeholders}) AND indexed_at >= $1`,
        [sinceIso, ...repoIds],
      )) as { file_path: string }[];
    });
    for (const r of rows) changedPaths.add(r.file_path);
  } else {
    const db = await getSqlite(repoRoot);
    const placeholders = repoIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT file_path FROM files
         WHERE repo_id IN (${placeholders}) AND indexed_at >= ?`,
      )
      .all(...repoIds, sinceIso) as { file_path: string }[];
    for (const r of rows) changedPaths.add(r.file_path);
  }

  if (changedPaths.size === 0) return [];

  // If no query, return changed files as basic results
  if (!query) {
    return Array.from(changedPaths).map((fp) => ({
      filePath: fp,
      cosineSimilarity: 0,
      finalScore: 0,
      type: "file",
      inProject: true,
    }));
  }

  // Run semantic search and intersect with changed files
  const semanticResults = await search(repoRoot, query, options);
  return semanticResults.filter((r) => r.type === "file" && changedPaths.has(r.filePath));
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
