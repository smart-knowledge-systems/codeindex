import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { statSync } from "fs";
import { search, searchChanged } from "../search/query";
import { embed } from "../index/embedder";
import { generateIntent } from "../intent";
import { detectDrift } from "../drift";
import { loadConfig } from "../config";
import { getPg, pgUnsafe } from "../db/pg";
import { withRepoScope } from "../db/rls";
import { getSqlite } from "../db/sqlite";
import { getCostSummary } from "../cost";
import { runHealthCheck } from "../check/runner";
import { getCurrentSchemaVersion } from "../db/migrate";
import type { SearchResult } from "../search/types";
import { CodeindexError, formatError } from "../errors";
import { validateRepoScope, type AuthSession } from "./auth";
import { recordEvent } from "../telemetry";
import { logEvent, getSessionId } from "../logging";
import { EmbeddingCache } from "./cache";
import { reindexSingleFile, loadFileIndex } from "../index/reindex";
import type { TransactionSQL } from "bun";

// ---------------------------------------------------------------------------
// RLS scope helper for MCP tool handlers
// ---------------------------------------------------------------------------

/**
 * Cached full-access repo IDs — avoids SELECT id FROM repos on every tool call.
 *
 * Note: newly indexed repos will not appear in search results until this cache
 * refreshes (up to 60 s). Call `invalidateRepoCache()` after repo creation to
 * avoid the visibility delay.
 */
interface RepoCache {
  ids: number[] | null;
  fetchedAt: number;
  inflight: Promise<number[]> | null;
}

const REPO_CACHE_TTL_MS = 60_000;

const repoCache: RepoCache = { ids: null, fetchedAt: 0, inflight: null };

/** Invalidate the full-access repo ID cache so newly indexed repos are visible immediately. */
export function invalidateRepoCache(): void {
  repoCache.ids = null;
  repoCache.fetchedAt = 0;
  repoCache.inflight = null;
}

async function fetchAllRepoIds(): Promise<number[]> {
  const rows = await pgUnsafe("SELECT id FROM repos");
  return rows.map((r: Record<string, unknown>) => Number(r.id));
}

/**
 * Wrap PG queries in an RLS-scoped transaction.
 * For scoped sessions: uses session.repoIds.
 * For full-access / no session: queries all repo IDs so RLS passes.
 */
async function withMcpScope<T>(
  session: AuthSession | undefined,
  fn: (tx: TransactionSQL) => Promise<T>,
): Promise<T> {
  if (session?.repoIds) {
    return withRepoScope(session.repoIds, fn);
  }
  // Full access — use cached repo IDs for FORCE RLS
  if (!repoCache.ids || Date.now() - repoCache.fetchedAt > REPO_CACHE_TTL_MS) {
    const stampBefore = repoCache.fetchedAt;
    if (!repoCache.inflight) {
      repoCache.inflight = fetchAllRepoIds().finally(() => {
        repoCache.inflight = null;
      });
    }
    const freshIds = await repoCache.inflight;
    // Only populate cache if it wasn't invalidated while we were awaiting
    if (repoCache.fetchedAt === stampBefore && freshIds) {
      repoCache.ids = freshIds;
      repoCache.fetchedAt = Date.now();
    }
  }
  // If cache is still empty (invalidated during fetch), do a fresh uncached query
  const allRepoIds = repoCache.ids ?? (await fetchAllRepoIds());
  if (allRepoIds.length === 0) {
    const pg = await getPg();
    return pg.begin(async (tx) => fn(tx));
  }
  return withRepoScope(allRepoIds, fn);
}

// ---------------------------------------------------------------------------
// Module-level reindex rate limiter (persists across SSE reconnections)
// ---------------------------------------------------------------------------

const REINDEX_RATE_LIMIT = 5;
const REINDEX_RATE_WINDOW_MS = 60_000;
// Keyed by session identity so per-user limits persist across reconnections
const reindexCallLogs = new Map<string, number[]>();

/** Escape SQL LIKE metacharacters (% and _) in a user-provided string. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

function reindexRateLimitKey(repoRoot: string, session?: AuthSession): string {
  if (!session || session.repoIds === null) return `${repoRoot}:full`;
  return `${repoRoot}:${session.repoIds.slice().sort().join(",")}`;
}

function checkReindexRateLimit(repoRoot: string, session?: AuthSession): boolean {
  const key = reindexRateLimitKey(repoRoot, session);
  const now = Date.now();
  const existing = reindexCallLogs.get(key) ?? [];
  const validCalls = existing.filter((ts) => now - ts <= REINDEX_RATE_WINDOW_MS);

  if (validCalls.length >= REINDEX_RATE_LIMIT) {
    reindexCallLogs.set(key, validCalls);
    return false;
  }

  reindexCallLogs.set(key, [...validCalls, now]);

  // Periodically evict stale/empty entries to prevent unbounded map growth
  if (reindexCallLogs.size > 100) {
    const cutoff = now - REINDEX_RATE_WINDOW_MS;
    for (const [k, v] of reindexCallLogs) {
      if (v.length === 0 || v[v.length - 1] < cutoff) reindexCallLogs.delete(k);
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// MCP response helpers — consistent success/error formatting
// ---------------------------------------------------------------------------

type McpToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

function mcpSuccess(data: unknown): McpToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function mcpError(message: string, code?: string): McpToolResponse {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message, ...(code ? { code } : {}) }),
      },
    ],
    isError: true,
  };
}

function mcpCatchError(err: unknown): McpToolResponse {
  const message = formatError(err);
  return mcpError(message, err instanceof CodeindexError ? err.code : undefined);
}

// ---------------------------------------------------------------------------
// Status helper (shared with CLI but returns structured data)
// ---------------------------------------------------------------------------

interface StatusResult {
  repo: string;
  rootPath: string;
  store: string;
  files: number;
  directories: number;
  commits: number;
  lastIndexed: string | null;
  formatter: string;
  cost?: {
    rows: Array<{
      operation: string;
      model: string;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
    }>;
    totalUsd: number;
  };
}

interface RepoRow {
  id: number;
  name: string;
  root_path: string;
  formatter_cmd: string | null;
}

interface StatusCounts {
  files: number;
  directories: number;
  commits: number;
  lastIndexed: string | null;
}

async function fetchRepoCounts(
  repoRoot: string,
  repoId: number,
  store: string,
  session?: AuthSession,
): Promise<StatusCounts> {
  if (store === "pg") {
    const [fileCount, dirCount, commitCount, lastIndexed] = await withMcpScope(
      session,
      async (tx) =>
        Promise.all([
          tx.unsafe("SELECT count(*) as cnt FROM files WHERE repo_id = $1", [repoId]),
          tx.unsafe("SELECT count(*) as cnt FROM directories WHERE repo_id = $1", [repoId]),
          tx.unsafe("SELECT count(*) as cnt FROM commits WHERE repo_id = $1", [repoId]),
          tx.unsafe("SELECT max(indexed_at) as last FROM files WHERE repo_id = $1", [repoId]),
        ]),
    );
    return {
      files: Number(fileCount[0].cnt),
      directories: Number(dirCount[0].cnt),
      commits: Number(commitCount[0].cnt),
      lastIndexed: lastIndexed[0].last ?? null,
    };
  }

  const db = await getSqlite(repoRoot);
  const fileCount = db
    .prepare("SELECT count(*) as cnt FROM files WHERE repo_id = ?")
    .get(repoId) as { cnt: number };
  const dirCount = db
    .prepare("SELECT count(*) as cnt FROM directories WHERE repo_id = ?")
    .get(repoId) as { cnt: number };
  const commitCount = db
    .prepare("SELECT count(*) as cnt FROM commits WHERE repo_id = ?")
    .get(repoId) as { cnt: number };
  const lastIndexed = db
    .prepare("SELECT max(indexed_at) as last FROM files WHERE repo_id = ?")
    .get(repoId) as { last: string | null };

  return {
    files: fileCount.cnt,
    directories: dirCount.cnt,
    commits: commitCount.cnt,
    lastIndexed: lastIndexed.last ?? null,
  };
}

async function buildCostSummary(repoRoot: string): Promise<StatusResult["cost"]> {
  const costRows = await getCostSummary(repoRoot);
  return {
    rows: costRows.map((r) => ({
      operation: r.operation,
      model: r.model,
      tokensIn: r.totalTokensIn,
      tokensOut: r.totalTokensOut,
      costUsd: r.totalCostUsd,
    })),
    totalUsd: costRows.reduce((sum, r) => sum + r.totalCostUsd, 0),
  };
}

async function fetchRepoRow(repoRoot: string, store: string): Promise<RepoRow> {
  if (store === "pg") {
    const repos = await pgUnsafe("SELECT * FROM repos WHERE root_path = $1", [repoRoot]);
    if (repos.length === 0) throw new Error("Not indexed yet. Run: codeindex reindex");
    return repos[0] as RepoRow;
  }
  const db = await getSqlite(repoRoot);
  const repo = db.prepare("SELECT * FROM repos WHERE root_path = ?").get(repoRoot) as
    | RepoRow
    | undefined;
  if (!repo) throw new Error("Not indexed yet. Run: codeindex reindex");
  return repo;
}

async function getStatus(
  repoRoot: string,
  showCost: boolean,
  session?: AuthSession,
): Promise<StatusResult> {
  const config = await loadConfig(repoRoot);
  const repo = await fetchRepoRow(repoRoot, config.store);
  const counts = await fetchRepoCounts(repoRoot, repo.id, config.store, session);

  const result: StatusResult = {
    repo: repo.name,
    rootPath: repo.root_path,
    store: config.store,
    ...counts,
    formatter: repo.formatter_cmd ?? "auto-detect",
  };

  if (showCost) {
    result.cost = await buildCostSummary(repoRoot);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Staleness check — compare indexed_at vs file mtime
// ---------------------------------------------------------------------------

async function batchGetIndexedAt(
  repoRoot: string,
  filePaths: string[],
  session?: AuthSession,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (filePaths.length === 0) return map;

  const config = await loadConfig(repoRoot);
  if (config.store === "pg") {
    const placeholders = filePaths.map((_, i) => `$${i + 2}`).join(",");
    const rows = (await withMcpScope(session, async (tx) =>
      tx.unsafe(
        `SELECT f.file_path, f.indexed_at::text AS indexed_at
       FROM files f JOIN repos r ON r.id = f.repo_id
       WHERE r.root_path = $1 AND f.file_path IN (${placeholders})`,
        [repoRoot, ...filePaths],
      ),
    )) as { file_path: string; indexed_at: string }[];
    for (const r of rows) map.set(r.file_path, r.indexed_at);
  } else {
    const db = await getSqlite(repoRoot);
    const placeholders = filePaths.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT f.file_path, f.indexed_at
         FROM files f JOIN repos r ON r.id = f.repo_id
         WHERE r.root_path = ? AND f.file_path IN (${placeholders})`,
      )
      .all(repoRoot, ...filePaths) as { file_path: string; indexed_at: string }[];
    for (const r of rows) map.set(r.file_path, r.indexed_at);
  }
  return map;
}

async function enrichResults(
  repoRoot: string,
  results: SearchResult[],
  session?: AuthSession,
): Promise<Array<SearchResult & { indexedAt?: string; stale?: boolean }>> {
  const filePaths = results.filter((r) => r.type !== "commit").map((r) => r.filePath);
  const indexedAtMap = await batchGetIndexedAt(repoRoot, filePaths, session);

  return results.map((r) => {
    if (r.type === "commit") return r;

    const indexedAt = indexedAtMap.get(r.filePath) ?? null;
    const stale = indexedAt ? isFileStale(r.repoPath ?? repoRoot, r.filePath, indexedAt) : false;
    return { ...r, indexedAt: indexedAt ?? undefined, stale };
  });
}

async function fetchHealthCounts(
  repoRoot: string,
  backend: string,
  session?: AuthSession,
): Promise<{ repoCount: number; fileCount: number; lastReindexAt: string | null }> {
  if (backend === "pg") {
    const repos = await pgUnsafe("SELECT id FROM repos WHERE root_path = $1", [repoRoot]);
    if (repos.length === 0) return { repoCount: 0, fileCount: 0, lastReindexAt: null };
    const repoId = repos[0].id;
    const [files, lastIdx] = await withMcpScope(session, async (tx) =>
      Promise.all([
        tx.unsafe("SELECT count(*) as cnt FROM files WHERE repo_id = $1", [repoId]),
        tx.unsafe("SELECT max(indexed_at)::text as last FROM files WHERE repo_id = $1", [repoId]),
      ]),
    );
    return {
      repoCount: repos.length,
      fileCount: Number(files[0].cnt),
      lastReindexAt: lastIdx[0].last ?? null,
    };
  }
  const db = await getSqlite(repoRoot);
  const repo = db.prepare("SELECT id FROM repos WHERE root_path = ?").get(repoRoot) as {
    id: number;
  } | null;
  if (!repo) return { repoCount: 0, fileCount: 0, lastReindexAt: null };
  const files = db.prepare("SELECT count(*) as cnt FROM files WHERE repo_id = ?").get(repo.id) as {
    cnt: number;
  };
  const lastIdx = db
    .prepare("SELECT max(indexed_at) as last FROM files WHERE repo_id = ?")
    .get(repo.id) as { last: string | null };
  return { repoCount: 1, fileCount: files.cnt, lastReindexAt: lastIdx.last ?? null };
}

function isFileStale(root: string, filePath: string, indexedAt: string): boolean {
  try {
    const stat = statSync(`${root}/${filePath}`);
    return stat.mtimeMs > new Date(indexedAt).getTime();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reindex helpers — extracted for composability (Issue 8)
// ---------------------------------------------------------------------------

function validatePaths(paths: string[], repoRoot: string): string | null {
  for (const p of paths) {
    if (p.includes("..") || path.isAbsolute(p)) {
      return `Invalid path: ${p} — paths must be relative and cannot contain '..'`;
    }
    const resolved = path.resolve(repoRoot, p);
    if (!resolved.startsWith(repoRoot + "/") && resolved !== repoRoot) {
      return `Path traversal detected: ${p} resolves outside repo root`;
    }
  }
  return null;
}

async function lookupRepoId(repoRoot: string, store: string): Promise<number | null> {
  if (store === "pg") {
    const repos = await pgUnsafe("SELECT id FROM repos WHERE root_path = $1", [repoRoot]);
    return repos.length > 0 ? (repos[0].id as number) : null;
  }
  const db = await getSqlite(repoRoot);
  const repo = db.prepare("SELECT id FROM repos WHERE root_path = ?").get(repoRoot) as
    | { id: number }
    | undefined;
  return repo?.id ?? null;
}

async function refreshFileId(
  repoRoot: string,
  repoId: number,
  filePath: string,
  store: string,
  fileIndex: { fileIdMap: Map<string, number> },
  session?: AuthSession,
): Promise<void> {
  if (store === "pg") {
    const rows = (await withMcpScope(session, async (tx) =>
      tx.unsafe("SELECT id FROM files WHERE repo_id = $1 AND file_path = $2", [repoId, filePath]),
    )) as { id: number }[];
    const row = rows[0];
    if (row) fileIndex.fileIdMap.set(filePath, row.id);
  } else {
    const db = await getSqlite(repoRoot);
    const row = db
      .prepare("SELECT id FROM files WHERE repo_id = ? AND file_path = ?")
      .get(repoId, filePath) as { id: number } | undefined;
    if (row) fileIndex.fileIdMap.set(filePath, row.id);
  }
}

// ---------------------------------------------------------------------------
// MCP Server creation
// ---------------------------------------------------------------------------

export function createMcpServer(defaultRepoRoot: string, session?: AuthSession): McpServer {
  const mcp = new McpServer(
    { name: "codeindex", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Server-level embedding cache shared across all search calls
  const embeddingCache = new EmbeddingCache();

  // --- search tool ---
  mcp.tool(
    "search",
    "Semantic code search across indexed repositories. Returns files, directories, and commits ranked by relevance.",
    {
      query: z.string().describe("Natural language search query"),
      topN: z.number().optional().describe("Maximum number of results to return"),
      minScore: z.number().optional().describe("Minimum score threshold (0-1)"),
      lang: z
        .string()
        .optional()
        .describe("Comma-separated language filter (ts,python,rust,go,java,c,cpp,cs)"),
      dir: z.string().optional().describe("Comma-separated directory prefix filter"),
      since: z.string().optional().describe("Time filter (30d, 2w, 3m, or ISO date)"),
      scope: z
        .string()
        .optional()
        .describe("Search scope: project, all, or comma-separated repo names"),
      explain: z.boolean().optional().describe("Include per-result score breakdown"),
    },
    async ({ query, topN, minScore, lang, dir, since, scope, explain }) => {
      try {
        recordEvent({
          event: "mcp_tool",
          timestamp: new Date().toISOString(),
          tool: "search",
          sessionId: getSessionId(),
        });
        if (session) {
          const allowed = await validateRepoScope(defaultRepoRoot, undefined, session);
          if (!allowed) return mcpError("access denied — repo not in token scope");
        }
        const repoRoot = defaultRepoRoot;
        const results = await search(repoRoot, query, {
          topN: topN ?? undefined,
          minScore: minScore ?? undefined,
          lang: lang ? lang.split(",") : undefined,
          dir: dir ? dir.split(",") : undefined,
          since: since ?? undefined,
          scope: scope === "all" ? "all" : scope ? scope.split(",") : "project",
          explain: explain ?? false,
          includeSkeleton: true,
          includeSummary: true,
          embeddingCache,
        });

        const enriched = await enrichResults(repoRoot, results, session);
        return mcpSuccess(enriched);
      } catch (err) {
        return mcpCatchError(err);
      }
    },
  );

  // --- batchSearch tool ---
  mcp.tool(
    "batchSearch",
    "Run multiple semantic search queries in a single call. Deduplicates and batch-embeds queries for efficiency.",
    {
      queries: z.array(z.string()).min(1).max(10).describe("Array of search queries (max 10)"),
      topN: z.number().optional().describe("Maximum results per query"),
      minScore: z.number().optional().describe("Minimum score threshold (0-1)"),
      scope: z
        .string()
        .optional()
        .describe("Search scope: project, all, or comma-separated repo names"),
    },
    async ({ queries, topN, minScore, scope }) => {
      try {
        recordEvent({
          event: "mcp_tool",
          timestamp: new Date().toISOString(),
          tool: "batchSearch",
          sessionId: getSessionId(),
        });
        if (session) {
          const allowed = await validateRepoScope(defaultRepoRoot, undefined, session);
          if (!allowed) return mcpError("access denied — repo not in token scope");
        }
        const repoRoot = defaultRepoRoot;

        // Deduplicate queries and batch-embed uncached ones
        const uniqueQueries = [...new Set(queries)];
        const uncached = uniqueQueries.filter((q) => !embeddingCache.get(q));

        if (uncached.length > 0) {
          const embeddings = await embed(uncached);
          if (embeddings.length < uncached.length) {
            logEvent({
              event: "infra.embedding.mismatch",
              expected: uncached.length,
              received: embeddings.length,
            });
          }
          uncached.forEach((q, i) => {
            if (i < embeddings.length) embeddingCache.set(q, embeddings[i]);
          });
        }

        // Run search for each unique query in parallel, then build lookup from results
        const resolvedScope = scope === "all" ? "all" : scope ? scope.split(",") : "project";

        const searchEntries = await Promise.all(
          uniqueQueries.map(async (q) => {
            const results = await search(repoRoot, q, {
              topN: topN ?? undefined,
              minScore: minScore ?? undefined,
              scope: resolvedScope as "project" | "all" | string[],
              includeSkeleton: true,
              includeSummary: true,
              embeddingCache,
            });
            const enriched = await enrichResults(repoRoot, results, session);
            return [q, enriched] as const;
          }),
        );
        const resultsByQuery = new Map(searchEntries);

        // Return array preserving original query order (including duplicates)
        const perQueryResults = queries.map((q) => ({
          query: q,
          results: resultsByQuery.get(q),
        }));

        return mcpSuccess(perQueryResults);
      } catch (err) {
        return mcpCatchError(err);
      }
    },
  );

  // --- searchChanged tool ---
  mcp.tool(
    "searchChanged",
    "Find files that were indexed after a given timestamp, optionally filtered by semantic query.",
    {
      since: z.string().describe("ISO date or relative duration (e.g. '1d', '7d', '2w', '3m')"),
      query: z.string().optional().describe("Optional semantic search query to intersect with"),
      topN: z.number().optional().describe("Maximum number of results to return"),
      minScore: z.number().optional().describe("Minimum score threshold (0-1)"),
      scope: z
        .string()
        .optional()
        .describe("Search scope: project, all, or comma-separated repo names"),
    },
    async ({ since, query, topN, minScore, scope }) => {
      try {
        recordEvent({
          event: "mcp_tool",
          timestamp: new Date().toISOString(),
          tool: "searchChanged",
          sessionId: getSessionId(),
        });
        if (session) {
          const allowed = await validateRepoScope(defaultRepoRoot, undefined, session);
          if (!allowed) return mcpError("access denied — repo not in token scope");
        }
        const repoRoot = defaultRepoRoot;
        const results = await searchChanged(repoRoot, since, query ?? undefined, {
          topN: topN ?? undefined,
          minScore: minScore ?? undefined,
          scope: scope === "all" ? "all" : scope ? scope.split(",") : "project",
          includeSkeleton: true,
          includeSummary: true,
          embeddingCache,
        });

        const enriched = await enrichResults(repoRoot, results, session);
        return mcpSuccess(enriched);
      } catch (err) {
        return mcpCatchError(err);
      }
    },
  );

  // --- intent tool ---
  mcp.tool(
    "intent",
    "Generate AGENTS.md content from directory summaries in the index. Returns the generated markdown.",
    {
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "intent",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError("access denied — repo not in token scope");
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const markdown = await generateIntent(repoRoot);

      return { content: [{ type: "text" as const, text: markdown }] };
    },
  );

  // --- drift tool ---
  mcp.tool(
    "drift",
    "Detect stale Intent Nodes by comparing AGENTS.md sections against current directory summary embeddings.",
    {
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
      threshold: z.number().optional().describe("Drift threshold (default 0.3)"),
      agentsMdPath: z.string().optional().describe("Path to AGENTS.md (default: AGENTS.md)"),
    },
    async ({ repoPath, threshold, agentsMdPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "drift",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError("access denied — repo not in token scope");
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const mdPath = agentsMdPath ?? path.join(repoRoot, "AGENTS.md");
      const results = await detectDrift(repoRoot, mdPath, threshold ?? undefined);
      return mcpSuccess(results);
    },
  );

  // --- status tool ---
  mcp.tool(
    "status",
    "Returns index statistics: file/directory/commit counts, last indexed timestamp, and optional cost breakdown.",
    {
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
      cost: z.boolean().optional().describe("Include token usage and cost breakdown"),
    },
    async ({ repoPath, cost }) => {
      try {
        recordEvent({
          event: "mcp_tool",
          timestamp: new Date().toISOString(),
          tool: "status",
          sessionId: getSessionId(),
        });
        if (session) {
          const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
          if (!allowed) return mcpError("access denied — repo not in token scope");
        }
        const repoRoot = repoPath ?? defaultRepoRoot;
        const status = await getStatus(repoRoot, cost ?? false, session);
        return mcpSuccess(status);
      } catch (err) {
        return mcpCatchError(err);
      }
    },
  );

  // --- check tool ---
  mcp.tool(
    "check",
    "Run health policy checks against the index. Returns pass/fail for freshness, summary completeness, skeleton extraction, and reindex completion.",
    {
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "check",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError("access denied — repo not in token scope");
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const report = await runHealthCheck(repoRoot);
      return mcpSuccess(report);
    },
  );

  // --- health tool ---
  mcp.tool(
    "health",
    "Returns system health: schema version, DB connectivity, repo/file counts, and last reindex timestamp.",
    {
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "health",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError("access denied — repo not in token scope");
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);
      const backend = config.store;

      try {
        const schemaVersion = await getCurrentSchemaVersion(backend, repoRoot);
        const { repoCount, fileCount, lastReindexAt } = await fetchHealthCounts(
          repoRoot,
          backend,
          session,
        );
        return mcpSuccess({
          schemaVersion,
          connectionOk: true,
          repoCount,
          fileCount,
          lastReindexAt,
        });
      } catch {
        return mcpSuccess({
          schemaVersion: 0,
          connectionOk: false,
          repoCount: 0,
          fileCount: 0,
          lastReindexAt: null,
        });
      }
    },
  );

  // --- getImporters tool ---
  mcp.tool(
    "getImporters",
    "Find all files that import a given file. Returns importer file paths with import specifiers.",
    {
      filePath: z.string().describe("Relative file path to find importers of"),
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ filePath, repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "getImporters",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError("access denied — repo not in token scope");
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);

      if (config.store === "pg") {
        const rows = await withMcpScope(session, async (tx) =>
          tx.unsafe(
            `SELECT sf.file_path AS importer, fi.imported_module
           FROM file_imports fi
           JOIN files tf ON tf.id = fi.resolved_file_id
           JOIN files sf ON sf.id = fi.source_file_id
           JOIN repos r ON r.id = tf.repo_id
           WHERE r.root_path = $1 AND tf.file_path = $2`,
            [repoRoot, filePath],
          ),
        );
        return mcpSuccess(rows);
      } else {
        const db = await getSqlite(repoRoot);
        const rows = db
          .prepare(
            `SELECT sf.file_path AS importer, fi.imported_module
             FROM file_imports fi
             JOIN files tf ON tf.id = fi.resolved_file_id
             JOIN files sf ON sf.id = fi.source_file_id
             JOIN repos r ON r.id = tf.repo_id
             WHERE r.root_path = ? AND tf.file_path = ?`,
          )
          .all(repoRoot, filePath);
        return mcpSuccess(rows);
      }
    },
  );

  // --- getDependencies tool ---
  mcp.tool(
    "getDependencies",
    "Find all files that a given file imports/depends on.",
    {
      filePath: z.string().describe("Relative file path to find dependencies of"),
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ filePath, repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "getDependencies",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError("access denied — repo not in token scope");
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);

      if (config.store === "pg") {
        const rows = await withMcpScope(session, async (tx) =>
          tx.unsafe(
            `SELECT tf.file_path AS dependency, fi.imported_module
           FROM file_imports fi
           JOIN files sf ON sf.id = fi.source_file_id
           LEFT JOIN files tf ON tf.id = fi.resolved_file_id
           JOIN repos r ON r.id = sf.repo_id
           WHERE r.root_path = $1 AND sf.file_path = $2`,
            [repoRoot, filePath],
          ),
        );
        return mcpSuccess(rows);
      } else {
        const db = await getSqlite(repoRoot);
        const rows = db
          .prepare(
            `SELECT tf.file_path AS dependency, fi.imported_module
             FROM file_imports fi
             JOIN files sf ON sf.id = fi.source_file_id
             LEFT JOIN files tf ON tf.id = fi.resolved_file_id
             JOIN repos r ON r.id = sf.repo_id
             WHERE r.root_path = ? AND sf.file_path = ?`,
          )
          .all(repoRoot, filePath);
        return mcpSuccess(rows);
      }
    },
  );

  // --- traceImportChain tool ---
  mcp.tool(
    "traceImportChain",
    "Trace the full import chain from a file, following dependencies recursively up to a max depth.",
    {
      filePath: z.string().describe("Starting file path"),
      direction: z
        .enum(["importers", "dependencies"])
        .optional()
        .describe("Direction to trace (default: dependencies)"),
      maxDepth: z.number().optional().describe("Maximum recursion depth (default: 10, max: 10)"),
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ filePath, direction, maxDepth, repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "traceImportChain",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError("access denied — repo not in token scope");
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);
      const depth = Math.min(maxDepth ?? 10, 10);
      const dir = direction ?? "dependencies";

      const scopedRepoIds = session?.repoIds ?? null;

      if (config.store === "pg") {
        const repoFilter = scopedRepoIds ? `AND nf.repo_id = ANY($4::int[])` : "";
        const params: unknown[] = [repoRoot, filePath, depth];
        if (scopedRepoIds) params.push(scopedRepoIds);
        const query =
          dir === "dependencies"
            ? `WITH RECURSIVE chain AS (
                 SELECT f.id, f.file_path, 0 AS depth
                 FROM files f JOIN repos r ON r.id = f.repo_id
                 WHERE r.root_path = $1 AND f.file_path = $2
               UNION ALL
                 SELECT nf.id, nf.file_path, c.depth + 1
                 FROM chain c
                 JOIN file_imports fi ON fi.source_file_id = c.id
                 JOIN files nf ON nf.id = fi.resolved_file_id
                 WHERE c.depth < $3 ${repoFilter}
               )
               SELECT DISTINCT file_path, depth FROM chain ORDER BY depth`
            : `WITH RECURSIVE chain AS (
                 SELECT f.id, f.file_path, 0 AS depth
                 FROM files f JOIN repos r ON r.id = f.repo_id
                 WHERE r.root_path = $1 AND f.file_path = $2
               UNION ALL
                 SELECT nf.id, nf.file_path, c.depth + 1
                 FROM chain c
                 JOIN file_imports fi ON fi.resolved_file_id = c.id
                 JOIN files nf ON nf.id = fi.source_file_id
                 WHERE c.depth < $3 ${repoFilter}
               )
               SELECT DISTINCT file_path, depth FROM chain ORDER BY depth`;
        const rows = await withMcpScope(session, async (tx) => tx.unsafe(query, params));
        return mcpSuccess(rows);
      } else {
        // SQLite: iterative BFS since recursive CTEs with dynamic column names are awkward
        const db = await getSqlite(repoRoot);
        const startRow = db
          .prepare(
            `SELECT f.id FROM files f JOIN repos r ON r.id = f.repo_id
             WHERE r.root_path = ? AND f.file_path = ?`,
          )
          .get(repoRoot, filePath) as { id: number } | null;
        if (!startRow) return mcpSuccess([]);

        // Build scope filter for SQLite
        const scopedFileIds = scopedRepoIds
          ? new Set(
              (
                db
                  .prepare(
                    `SELECT id FROM files WHERE repo_id IN (${scopedRepoIds.map(() => "?").join(",")})`,
                  )
                  .all(...scopedRepoIds) as { id: number }[]
              ).map((r) => r.id),
            )
          : null;

        const filePathStmt = db.prepare(`SELECT file_path FROM files WHERE id = ?`);
        const importStmt =
          dir === "dependencies"
            ? db.prepare(
                `SELECT resolved_file_id AS next_id FROM file_imports WHERE source_file_id = ? AND resolved_file_id IS NOT NULL`,
              )
            : db.prepare(
                `SELECT source_file_id AS next_id FROM file_imports WHERE resolved_file_id = ?`,
              );

        const startFilePath = (filePathStmt.get(startRow.id) as { file_path: string }).file_path;

        // BFS traversal using reduce-style iteration over depth levels
        type BfsState = {
          visited: Map<number, { file_path: string; depth: number }>;
          frontier: number[];
          currentDepth: number;
        };

        const expandFrontier = (state: BfsState): BfsState => {
          const nextDepth = state.currentDepth + 1;
          const newEntries = state.frontier.flatMap((id) => {
            const nexts = importStmt.all(id) as { next_id: number }[];
            return nexts
              .filter((n) => !state.visited.has(n.next_id))
              .filter((n) => !scopedFileIds || scopedFileIds.has(n.next_id))
              .map((n) => {
                const fp = (filePathStmt.get(n.next_id) as { file_path: string }).file_path;
                return { id: n.next_id, file_path: fp, depth: nextDepth };
              });
          });

          const nextVisited = new Map(state.visited);
          const nextFrontier: number[] = [];
          for (const entry of newEntries) {
            if (!nextVisited.has(entry.id)) {
              nextVisited.set(entry.id, { file_path: entry.file_path, depth: entry.depth });
              nextFrontier.push(entry.id);
            }
          }
          return { visited: nextVisited, frontier: nextFrontier, currentDepth: nextDepth };
        };

        let state: BfsState = {
          visited: new Map([[startRow.id, { file_path: startFilePath, depth: 0 }]]),
          frontier: [startRow.id],
          currentDepth: 0,
        };

        while (state.frontier.length > 0 && state.currentDepth < depth) {
          state = expandFrontier(state);
        }

        const results = [...state.visited.values()].sort((a, b) => a.depth - b.depth);
        return mcpSuccess(results);
      }
    },
  );

  // --- getCrossRepoEdges tool ---
  mcp.tool(
    "getCrossRepoEdges",
    "Get cross-repository dependency edges, showing how repos depend on each other.",
    {
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "getCrossRepoEdges",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError("access denied — repo not in token scope");
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);
      const scopedRepoIds = session?.repoIds ?? null;

      if (config.store === "pg") {
        const query = scopedRepoIds
          ? `SELECT sr.name AS source_repo, tr.name AS target_repo,
                    sf.file_path AS source_file, tf.file_path AS target_file,
                    e.imported_module
             FROM cross_repo_edges e
             JOIN repos sr ON sr.id = e.source_repo_id
             JOIN repos tr ON tr.id = e.target_repo_id
             JOIN files sf ON sf.id = e.source_file_id
             JOIN files tf ON tf.id = e.target_file_id
             WHERE (e.source_repo_id = ANY($1::int[]) OR e.target_repo_id = ANY($1::int[]))
             ORDER BY sr.name, tr.name`
          : `SELECT sr.name AS source_repo, tr.name AS target_repo,
                    sf.file_path AS source_file, tf.file_path AS target_file,
                    e.imported_module
             FROM cross_repo_edges e
             JOIN repos sr ON sr.id = e.source_repo_id
             JOIN repos tr ON tr.id = e.target_repo_id
             JOIN files sf ON sf.id = e.source_file_id
             JOIN files tf ON tf.id = e.target_file_id
             ORDER BY sr.name, tr.name`;
        const params = scopedRepoIds ? [scopedRepoIds] : [];
        const rows = await withMcpScope(session, async (tx) => tx.unsafe(query, params));
        return mcpSuccess(rows);
      } else {
        const db = await getSqlite(repoRoot);
        if (scopedRepoIds && scopedRepoIds.length > 0) {
          const placeholders = scopedRepoIds.map(() => "?").join(",");
          const rows = db
            .prepare(
              `SELECT sr.name AS source_repo, tr.name AS target_repo,
                      sf.file_path AS source_file, tf.file_path AS target_file,
                      e.imported_module
               FROM cross_repo_edges e
               JOIN repos sr ON sr.id = e.source_repo_id
               JOIN repos tr ON tr.id = e.target_repo_id
               JOIN files sf ON sf.id = e.source_file_id
               JOIN files tf ON tf.id = e.target_file_id
               WHERE (e.source_repo_id IN (${placeholders}) OR e.target_repo_id IN (${placeholders}))
               ORDER BY sr.name, tr.name`,
            )
            .all(...scopedRepoIds, ...scopedRepoIds);
          return mcpSuccess(rows);
        } else {
          const rows = db
            .prepare(
              `SELECT sr.name AS source_repo, tr.name AS target_repo,
                      sf.file_path AS source_file, tf.file_path AS target_file,
                      e.imported_module
               FROM cross_repo_edges e
               JOIN repos sr ON sr.id = e.source_repo_id
               JOIN repos tr ON tr.id = e.target_repo_id
               JOIN files sf ON sf.id = e.source_file_id
               JOIN files tf ON tf.id = e.target_file_id
               ORDER BY sr.name, tr.name`,
            )
            .all();
          return mcpSuccess(rows);
        }
      }
    },
  );

  // --- findImplementors tool ---
  mcp.tool(
    "findImplementors",
    "Find files that implement or extend a given interface/class/trait by searching skeleton entries.",
    {
      symbol: z.string().describe("Interface, class, or trait name to find implementors of"),
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ symbol, repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "findImplementors",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError("access denied — repo not in token scope");
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);
      const pattern = `%${escapeLike(symbol)}%`;
      const scopedRepoIds = session?.repoIds ?? null;

      if (config.store === "pg") {
        const query = scopedRepoIds
          ? `SELECT f.file_path, f.skeleton_entries, r.name AS repo_name
             FROM files f
             JOIN repos r ON r.id = f.repo_id
             WHERE f.skeleton LIKE $1 ESCAPE '\\'
               AND (f.skeleton LIKE '%implements%' OR f.skeleton LIKE '%extends%'
                    OR f.skeleton LIKE '%: %' OR f.skeleton LIKE '%conform%')
               AND r.id = ANY($2::int[])
             LIMIT 100`
          : `SELECT f.file_path, f.skeleton_entries, r.name AS repo_name
             FROM files f
             JOIN repos r ON r.id = f.repo_id
             WHERE f.skeleton LIKE $1 ESCAPE '\\'
               AND (f.skeleton LIKE '%implements%' OR f.skeleton LIKE '%extends%'
                    OR f.skeleton LIKE '%: %' OR f.skeleton LIKE '%conform%')
             LIMIT 100`;
        const params = scopedRepoIds ? [pattern, scopedRepoIds] : [pattern];
        const rows = await withMcpScope(session, async (tx) => tx.unsafe(query, params));
        return mcpSuccess(rows);
      } else {
        const db = await getSqlite(repoRoot);
        const scopeFilter =
          scopedRepoIds && scopedRepoIds.length > 0
            ? `AND r.id IN (${scopedRepoIds.map(() => "?").join(",")})`
            : "";
        const scopeParams = scopedRepoIds && scopedRepoIds.length > 0 ? scopedRepoIds : [];
        const rows = db
          .prepare(
            `SELECT f.file_path, f.skeleton_entries, r.name AS repo_name
             FROM files f
             JOIN repos r ON r.id = f.repo_id
             WHERE f.skeleton LIKE ? ESCAPE '\\'
               AND (f.skeleton LIKE '%implements%' OR f.skeleton LIKE '%extends%'
                    OR f.skeleton LIKE '%: %' OR f.skeleton LIKE '%conform%')
               ${scopeFilter}
             LIMIT 100`,
          )
          .all(pattern, ...scopeParams);
        return mcpSuccess(rows);
      }
    },
  );

  // --- findCallers tool ---
  mcp.tool(
    "findCallers",
    "Find files that import and potentially call a given symbol by searching import specifiers and skeletons.",
    {
      symbol: z.string().describe("Function, class, or symbol name to find callers of"),
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ symbol, repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "findCallers",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError("access denied — repo not in token scope");
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);
      const pattern = `%${escapeLike(symbol)}%`;
      const scopedRepoIds = session?.repoIds ?? null;

      if (config.store === "pg") {
        const query = scopedRepoIds
          ? `SELECT DISTINCT sf.file_path, r.name AS repo_name, fi.imported_module
             FROM file_imports fi
             JOIN files sf ON sf.id = fi.source_file_id
             JOIN repos r ON r.id = sf.repo_id
             WHERE fi.imported_module LIKE $1 ESCAPE '\\'
               AND r.id = ANY($2::int[])
             ORDER BY r.name, sf.file_path
             LIMIT 100`
          : `SELECT DISTINCT sf.file_path, r.name AS repo_name, fi.imported_module
             FROM file_imports fi
             JOIN files sf ON sf.id = fi.source_file_id
             JOIN repos r ON r.id = sf.repo_id
             WHERE fi.imported_module LIKE $1 ESCAPE '\\'
             ORDER BY r.name, sf.file_path
             LIMIT 100`;
        const params = scopedRepoIds ? [pattern, scopedRepoIds] : [pattern];
        const rows = await withMcpScope(session, async (tx) => tx.unsafe(query, params));
        return mcpSuccess(rows);
      } else {
        const db = await getSqlite(repoRoot);
        const scopeFilter =
          scopedRepoIds && scopedRepoIds.length > 0
            ? `AND r.id IN (${scopedRepoIds.map(() => "?").join(",")})`
            : "";
        const scopeParams = scopedRepoIds && scopedRepoIds.length > 0 ? scopedRepoIds : [];
        const rows = db
          .prepare(
            `SELECT DISTINCT sf.file_path, r.name AS repo_name, fi.imported_module
             FROM file_imports fi
             JOIN files sf ON sf.id = fi.source_file_id
             JOIN repos r ON r.id = sf.repo_id
             WHERE fi.imported_module LIKE ? ESCAPE '\\'
               ${scopeFilter}
             ORDER BY r.name, sf.file_path
             LIMIT 100`,
          )
          .all(pattern, ...scopeParams);
        return mcpSuccess(rows);
      }
    },
  );

  // --- reindexFiles tool ---

  mcp.tool(
    "reindexFiles",
    "Re-index specific files. Extracts skeleton, embeds, and upserts into the index. Rate limited to 5 calls/min.",
    {
      paths: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Relative file paths to re-index (max 50)"),
    },
    async ({ paths }) => {
      try {
        recordEvent({
          event: "mcp_tool",
          timestamp: new Date().toISOString(),
          tool: "reindexFiles",
          sessionId: getSessionId(),
        });

        // Scope validation
        if (session) {
          const allowed = await validateRepoScope(defaultRepoRoot, undefined, session);
          if (!allowed) return mcpError("access denied — repo not in token scope");
        }

        // Rate limit check (module-level, persists across reconnections, per-session)
        if (!checkReindexRateLimit(defaultRepoRoot, session)) {
          return mcpError("Rate limit exceeded: max 5 reindexFiles calls per minute");
        }

        // Path traversal validation
        const repoRoot = defaultRepoRoot;
        const pathError = validatePaths(paths, repoRoot);
        if (pathError) return mcpError(pathError);

        // Get repo ID
        const config = await loadConfig(repoRoot);
        const repoId = await lookupRepoId(repoRoot, config.store);
        if (repoId === null) return mcpError("Repository not indexed yet");

        // Pre-load file index once for import resolution across the batch
        const fileIndex = await loadFileIndex(repoRoot, repoId);

        const results: { path: string; indexed: boolean; error?: string }[] = [];
        for (const p of paths) {
          try {
            const indexed = await reindexSingleFile(repoRoot, repoId, p, fileIndex);
            results.push({ path: p, indexed });
            // Keep fileIndex up-to-date so later files in the batch can resolve
            // imports to files inserted earlier in the same batch
            if (indexed) {
              fileIndex.allFiles.add(p);
              if (!fileIndex.fileIdMap.has(p)) {
                await refreshFileId(repoRoot, repoId, p, config.store, fileIndex, session);
              }
            }
          } catch (err) {
            results.push({ path: p, indexed: false, error: formatError(err) });
          }
        }

        if (results.some((r) => r.indexed)) invalidateRepoCache();

        return mcpSuccess({
          indexed: results.filter((r) => r.indexed).length,
          skipped: results.filter((r) => !r.indexed && !r.error).length,
          errors: results.filter((r) => r.error).length,
          details: results,
        });
      } catch (err) {
        return mcpCatchError(err);
      }
    },
  );

  return mcp;
}
