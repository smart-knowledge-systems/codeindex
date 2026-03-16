import { z } from "zod";
import { search, searchChanged } from "../../search/query";
import { embed } from "../../index/embedder";
import { validateRepoScope } from "../auth";
import { recordEvent } from "../../telemetry";
import { logEvent, getSessionId } from "../../logging";
import type { McpToolContext } from "../helpers";
import { mcpSuccess, mcpError, mcpCatchError, enrichResults, ACCESS_DENIED_MSG } from "../helpers";

export function registerSearchTools(ctx: McpToolContext): void {
  const { mcp, defaultRepoRoot, session, embeddingCache } = ctx;

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
          if (!allowed) return mcpError(ACCESS_DENIED_MSG);
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
          if (!allowed) return mcpError(ACCESS_DENIED_MSG);
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
          if (!allowed) return mcpError(ACCESS_DENIED_MSG);
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
}
