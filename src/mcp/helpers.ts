import path from "path";
import { statSync } from "fs";
import { loadConfig } from "../config";
import { getPg, pgUnsafe } from "../db/pg";
import { withRepoScope } from "../db/rls";
import { getSqlite } from "../db/sqlite";
import { getCostSummary } from "../cost";
import { CodeindexError, formatError } from "../errors";
import type { AuthSession } from "./auth";
import type { SearchResult } from "../search/types";
import type { TransactionSQL } from "bun";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EmbeddingCache } from "./cache";

// ---------------------------------------------------------------------------
// MCP tool context — shared state passed to each tool register function
// ---------------------------------------------------------------------------

export interface McpToolContext {
  mcp: McpServer;
  defaultRepoRoot: string;
  session?: AuthSession;
  embeddingCache: EmbeddingCache;
}

export function createToolContext(
  mcp: McpServer,
  defaultRepoRoot: string,
  session?: AuthSession,
): McpToolContext {
  return { mcp, defaultRepoRoot, session, embeddingCache: new EmbeddingCache() };
}

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
export const ACCESS_DENIED_MSG = "access denied — repo not in token scope";

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
export async function withMcpScope<T>(
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

function reindexRateLimitKey(repoRoot: string, session?: AuthSession): string {
  if (!session || session.repoIds === null) return `${repoRoot}:full`;
  return `${repoRoot}:${session.repoIds.slice().sort().join(",")}`;
}

export function checkReindexRateLimit(repoRoot: string, session?: AuthSession): boolean {
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

export type McpToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

export function mcpSuccess(data: unknown): McpToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function mcpError(message: string, code?: string): McpToolResponse {
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

export function mcpCatchError(err: unknown): McpToolResponse {
  const message = formatError(err);
  return mcpError(message, err instanceof CodeindexError ? err.code : undefined);
}

// ---------------------------------------------------------------------------
// Status helper (shared with CLI but returns structured data)
// ---------------------------------------------------------------------------

export interface StatusResult {
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

export async function getStatus(
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

function isFileStale(root: string, filePath: string, indexedAt: string): boolean {
  try {
    const stat = statSync(`${root}/${filePath}`);
    return stat.mtimeMs > new Date(indexedAt).getTime();
  } catch {
    return false;
  }
}

export async function enrichResults(
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

export async function fetchHealthCounts(
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

// ---------------------------------------------------------------------------
// Path validation helpers
// ---------------------------------------------------------------------------

/** Escape SQL LIKE metacharacters (% and _) in a user-provided string. */
export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

export function validatePaths(paths: string[], repoRoot: string): string | null {
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

export async function refreshFileId(
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
