import { z } from "zod";
import { loadConfig } from "../../config";
import { getCurrentSchemaVersion } from "../../db/migrate";
import { runHealthCheck } from "../../check/runner";
import { validateRepoScope } from "../auth";
import { recordEvent } from "../../telemetry";
import { getSessionId } from "../../logging";
import type { McpToolContext } from "../helpers";
import {
  mcpSuccess,
  mcpError,
  mcpCatchError,
  getStatus,
  fetchHealthCounts,
  ACCESS_DENIED_MSG,
} from "../helpers";

export function registerStatusTools(ctx: McpToolContext): void {
  const { mcp, defaultRepoRoot, session } = ctx;

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
          if (!allowed) return mcpError(ACCESS_DENIED_MSG);
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
        if (!allowed) return mcpError(ACCESS_DENIED_MSG);
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
        if (!allowed) return mcpError(ACCESS_DENIED_MSG);
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
}
