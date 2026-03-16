import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthSession } from "./auth";
import { createToolContext } from "./helpers";
import { registerSearchTools } from "./tools/search";
import { registerStatusTools } from "./tools/status";
import { registerAnalysisTools } from "./tools/analysis";
import { registerReindexTools } from "./tools/reindex";
import { registerFileTools } from "./tools/files";

// Re-export invalidateRepoCache so existing callers continue to work
export { invalidateRepoCache } from "./helpers";

// ---------------------------------------------------------------------------
// MCP Server creation
// ---------------------------------------------------------------------------

export function createMcpServer(defaultRepoRoot: string, session?: AuthSession): McpServer {
  const mcp = new McpServer(
    { name: "codeindex", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const ctx = createToolContext(mcp, defaultRepoRoot, session);

  registerSearchTools(ctx);
  registerStatusTools(ctx);
  registerAnalysisTools(ctx);
  registerReindexTools(ctx);
  registerFileTools(ctx);

  return mcp;
}
