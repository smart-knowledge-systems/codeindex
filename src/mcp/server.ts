import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { statSync } from "fs";
import { search } from "../search/query";
import { generateIntent } from "../intent";
import { detectDrift } from "../drift";
import { loadConfig } from "../config";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { getCostSummary } from "../cost";
import { runHealthCheck } from "../check/runner";
import { getCurrentSchemaVersion } from "../db/migrate";
import type { SearchResult } from "../search/types";
import { CodeindexError, formatError } from "../errors";
import { validateRepoScope, type AuthSession } from "./auth";
import { recordEvent } from "../telemetry";
import { EmbeddingCache } from "./cache";

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

async function getStatus(repoRoot: string, showCost: boolean): Promise<StatusResult> {
  const config = await loadConfig(repoRoot);

  if (config.store === "pg") {
    const repos = await pgUnsafe("SELECT * FROM repos WHERE root_path = $1", [repoRoot]);
    if (repos.length === 0) throw new Error("Not indexed yet. Run: codeindex reindex");
    const repoId = repos[0].id;

    const [fileCount, dirCount, commitCount, lastIndexed] = await Promise.all([
      pgUnsafe("SELECT count(*) as cnt FROM files WHERE repo_id = $1", [repoId]),
      pgUnsafe("SELECT count(*) as cnt FROM directories WHERE repo_id = $1", [repoId]),
      pgUnsafe("SELECT count(*) as cnt FROM commits WHERE repo_id = $1", [repoId]),
      pgUnsafe("SELECT max(indexed_at) as last FROM files WHERE repo_id = $1", [repoId]),
    ]);

    const result: StatusResult = {
      repo: repos[0].name,
      rootPath: repos[0].root_path,
      store: "pg",
      files: Number(fileCount[0].cnt),
      directories: Number(dirCount[0].cnt),
      commits: Number(commitCount[0].cnt),
      lastIndexed: lastIndexed[0].last ?? null,
      formatter: repos[0].formatter_cmd ?? "auto-detect",
    };

    if (showCost) {
      const costRows = await getCostSummary(repoRoot);
      result.cost = {
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

    return result;
  } else {
    const db = await getSqlite(repoRoot);
    const repos = db.prepare("SELECT * FROM repos WHERE root_path = ?").all(repoRoot) as {
      id: number;
      name: string;
      root_path: string;
      formatter_cmd: string | null;
    }[];
    if (repos.length === 0) throw new Error("Not indexed yet. Run: codeindex reindex");
    const repoId = repos[0].id;

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

    const result: StatusResult = {
      repo: repos[0].name,
      rootPath: repos[0].root_path,
      store: "sqlite",
      files: fileCount.cnt,
      directories: dirCount.cnt,
      commits: commitCount.cnt,
      lastIndexed: lastIndexed.last ?? null,
      formatter: repos[0].formatter_cmd ?? "auto-detect",
    };

    if (showCost) {
      const costRows = await getCostSummary(repoRoot);
      result.cost = {
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

    return result;
  }
}

// ---------------------------------------------------------------------------
// Staleness check — compare indexed_at vs file mtime
// ---------------------------------------------------------------------------

async function batchGetIndexedAt(
  repoRoot: string,
  filePaths: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (filePaths.length === 0) return map;

  const config = await loadConfig(repoRoot);
  if (config.store === "pg") {
    const placeholders = filePaths.map((_, i) => `$${i + 2}`).join(",");
    const rows = (await pgUnsafe(
      `SELECT f.file_path, f.indexed_at::text AS indexed_at
       FROM files f JOIN repos r ON r.id = f.repo_id
       WHERE r.root_path = $1 AND f.file_path IN (${placeholders})`,
      [repoRoot, ...filePaths],
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
): Promise<Array<SearchResult & { indexedAt?: string; stale?: boolean }>> {
  const filePaths = results.filter((r) => r.type !== "commit").map((r) => r.filePath);
  const indexedAtMap = await batchGetIndexedAt(repoRoot, filePaths);
  const enriched = [];
  for (const r of results) {
    if (r.type === "commit") {
      enriched.push(r);
      continue;
    }
    const indexedAt = indexedAtMap.get(r.filePath) ?? null;
    let stale = false;
    if (indexedAt) {
      try {
        const effectiveRoot = r.repoPath ?? repoRoot;
        const absPath = `${effectiveRoot}/${r.filePath}`;
        const stat = statSync(absPath);
        stale = stat.mtimeMs > new Date(indexedAt).getTime();
      } catch {
        // file may not exist on disk
      }
    }
    enriched.push({ ...r, indexedAt: indexedAt ?? undefined, stale });
  }
  return enriched;
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
        recordEvent({ event: "mcp_tool", timestamp: new Date().toISOString(), tool: "search" });
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

        const enriched = await enrichResults(repoRoot, results);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(enriched, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = formatError(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: message,
                code: err instanceof CodeindexError ? err.code : undefined,
              }),
            },
          ],
          isError: true,
        };
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
      recordEvent({ event: "mcp_tool", timestamp: new Date().toISOString(), tool: "intent" });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) {
          return {
            content: [
              { type: "text" as const, text: "Error: access denied — repo not in token scope" },
            ],
          };
        }
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const markdown = await generateIntent(repoRoot);

      return {
        content: [{ type: "text" as const, text: markdown }],
      };
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
      recordEvent({ event: "mcp_tool", timestamp: new Date().toISOString(), tool: "drift" });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) {
          return {
            content: [
              { type: "text" as const, text: "Error: access denied — repo not in token scope" },
            ],
          };
        }
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const mdPath = agentsMdPath ?? path.join(repoRoot, "AGENTS.md");

      const results = await detectDrift(repoRoot, mdPath, threshold ?? undefined);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
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
        recordEvent({ event: "mcp_tool", timestamp: new Date().toISOString(), tool: "status" });
        if (session) {
          const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
          if (!allowed) {
            return {
              content: [
                { type: "text" as const, text: "Error: access denied — repo not in token scope" },
              ],
            };
          }
        }
        const repoRoot = repoPath ?? defaultRepoRoot;
        const status = await getStatus(repoRoot, cost ?? false);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = formatError(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: message,
                code: err instanceof CodeindexError ? err.code : undefined,
              }),
            },
          ],
          isError: true,
        };
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
      recordEvent({ event: "mcp_tool", timestamp: new Date().toISOString(), tool: "check" });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) {
          return {
            content: [
              { type: "text" as const, text: "Error: access denied — repo not in token scope" },
            ],
          };
        }
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const report = await runHealthCheck(repoRoot);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
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
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);
      const backend = config.store;

      try {
        const schemaVersion = await getCurrentSchemaVersion(backend, repoRoot);
        let repoCount = 0;
        let fileCount = 0;
        let lastReindexAt: string | null = null;

        if (backend === "pg") {
          const repos = await pgUnsafe("SELECT count(*) as cnt FROM repos");
          repoCount = Number(repos[0].cnt);
          const files = await pgUnsafe("SELECT count(*) as cnt FROM files");
          fileCount = Number(files[0].cnt);
          const lastIdx = await pgUnsafe("SELECT max(indexed_at)::text as last FROM files");
          lastReindexAt = lastIdx[0].last ?? null;
        } else {
          const db = await getSqlite(repoRoot);
          const repos = db.prepare("SELECT count(*) as cnt FROM repos").get() as {
            cnt: number;
          };
          repoCount = repos.cnt;
          const files = db.prepare("SELECT count(*) as cnt FROM files").get() as {
            cnt: number;
          };
          fileCount = files.cnt;
          const lastIdx = db.prepare("SELECT max(indexed_at) as last FROM files").get() as {
            last: string | null;
          };
          lastReindexAt = lastIdx.last ?? null;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  schemaVersion,
                  connectionOk: true,
                  repoCount,
                  fileCount,
                  lastReindexAt,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  schemaVersion: 0,
                  connectionOk: false,
                  repoCount: 0,
                  fileCount: 0,
                  lastReindexAt: null,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  return mcp;
}
