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
import type { SearchResult } from "../search/types";

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

async function getIndexedAt(repoRoot: string, filePath: string): Promise<string | null> {
  const config = await loadConfig(repoRoot);
  if (config.store === "pg") {
    const rows = await pgUnsafe(
      `SELECT indexed_at FROM files
       WHERE repo_id IN (SELECT id FROM repos WHERE root_path = $1)
         AND file_path = $2`,
      [repoRoot, filePath],
    );
    return rows.length > 0 ? (rows[0].indexed_at as string) : null;
  } else {
    const db = await getSqlite(repoRoot);
    const row = db
      .prepare(
        `SELECT f.indexed_at FROM files f
         JOIN repos r ON r.id = f.repo_id
         WHERE r.root_path = ? AND f.file_path = ?`,
      )
      .get(repoRoot, filePath) as { indexed_at: string } | null;
    return row?.indexed_at ?? null;
  }
}

async function enrichResults(
  repoRoot: string,
  results: SearchResult[],
): Promise<Array<SearchResult & { indexedAt?: string; stale?: boolean }>> {
  const enriched = [];
  for (const r of results) {
    if (r.type === "commit") {
      enriched.push(r);
      continue;
    }
    const effectiveRoot = r.repoPath ?? repoRoot;
    const indexedAt = await getIndexedAt(effectiveRoot, r.filePath);
    let stale = false;
    if (indexedAt) {
      try {
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

export function createMcpServer(defaultRepoRoot: string): McpServer {
  const mcp = new McpServer(
    { name: "codeindex", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

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
      const repoRoot = repoPath ?? defaultRepoRoot;

      // Capture stdout to return as result
      const chunks: string[] = [];
      const origWrite = process.stdout.write;
      process.stdout.write = (chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      };

      try {
        await generateIntent(repoRoot);
      } finally {
        process.stdout.write = origWrite;
      }

      return {
        content: [{ type: "text" as const, text: chunks.join("") }],
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
      const repoRoot = repoPath ?? defaultRepoRoot;
      const mdPath = agentsMdPath ?? "AGENTS.md";

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
    },
  );

  // --- check tool ---
  mcp.tool(
    "check",
    "Run health policy checks against the index. Returns pass/fail for freshness, summary completeness, skeleton extraction, and secret scan coverage.",
    {
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ repoPath }) => {
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

  return mcp;
}
