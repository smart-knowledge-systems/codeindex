import { z } from "zod";
import { loadConfig } from "../../config";
import { formatError } from "../../errors";
import { reindexSingleFile, loadFileIndex } from "../../index/reindex";
import { getRepoIdByPath } from "../../db/repo-lookup";
import { validateRepoScope } from "../auth";
import { recordEvent } from "../../telemetry";
import { getSessionId } from "../../logging";
import type { McpToolContext } from "../helpers";
import {
  mcpSuccess,
  mcpError,
  mcpCatchError,
  invalidateRepoCache,
  checkReindexRateLimit,
  validatePaths,
  refreshFileId,
  ACCESS_DENIED_MSG,
} from "../helpers";

export function registerReindexTools(ctx: McpToolContext): void {
  const { mcp, defaultRepoRoot, session } = ctx;

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
          if (!allowed) return mcpError(ACCESS_DENIED_MSG);
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
        const repoId = await getRepoIdByPath(repoRoot);
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
}
