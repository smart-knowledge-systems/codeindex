import path from "path";
import { z } from "zod";
import { generateIntent } from "../../intent";
import { detectDrift } from "../../drift";
import { validateRepoScope } from "../auth";
import { recordEvent } from "../../telemetry";
import { getSessionId } from "../../logging";
import type { McpToolContext } from "../helpers";
import { mcpSuccess, mcpError, ACCESS_DENIED_MSG } from "../helpers";

export function registerAnalysisTools(ctx: McpToolContext): void {
  const { mcp, defaultRepoRoot, session } = ctx;

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
        if (!allowed) return mcpError(ACCESS_DENIED_MSG);
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
        if (!allowed) return mcpError(ACCESS_DENIED_MSG);
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const mdPath = agentsMdPath ?? path.join(repoRoot, "AGENTS.md");
      const results = await detectDrift(repoRoot, mdPath, threshold ?? undefined);
      return mcpSuccess(results);
    },
  );
}
