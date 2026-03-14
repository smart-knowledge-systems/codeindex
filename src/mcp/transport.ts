import crypto from "crypto";
import { createServer } from "http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authenticateSession, type AuthSession } from "./auth";

export interface SessionEntry {
  transport: SSEServerTransport;
  token?: string;
  session?: AuthSession;
}

/**
 * Start the MCP server with stdio transport (default).
 * Reads JSON-RPC from stdin and writes to stdout.
 * If CODEINDEX_TOKEN is set, validates it at startup.
 */
export async function startStdio(server: McpServer, repoRoot: string): Promise<AuthSession | null> {
  const token = process.env.CODEINDEX_TOKEN;
  const session = await authenticateSession(repoRoot, token);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return session;
}

/**
 * Start the MCP server with SSE transport over HTTP.
 * Clients connect via GET /sse for the event stream and POST /message to send requests.
 * Supports multiple concurrent clients via session-keyed transports.
 * Extracts Bearer token from Authorization header for auth.
 */
export async function startSSE(
  server: McpServer,
  port: number,
  repoRoot: string,
): Promise<Map<string, SessionEntry>> {
  const sessions = new Map<string, SessionEntry>();

  const httpServer = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/sse") {
      // Extract Bearer token from Authorization header
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;

      const session = await authenticateSession(repoRoot, token);
      if (session === null) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized: invalid or missing token");
        return;
      }

      const sessionId = crypto.randomUUID();
      const transport = new SSEServerTransport(`/message?sessionId=${sessionId}`, res);
      sessions.set(sessionId, { transport, token, session });
      res.on("close", () => sessions.delete(sessionId));
      await server.connect(transport);
    } else if (req.method === "POST" && req.url?.startsWith("/message")) {
      const url = new URL(req.url, `http://localhost:${port}`);
      const sessionId = url.searchParams.get("sessionId");
      const entry = sessionId ? sessions.get(sessionId) : undefined;
      if (!entry) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Unknown or missing session. GET /sse first.");
        return;
      }
      await entry.transport.handlePostMessage(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });

  httpServer.listen(port, () => {
    console.error(`codeindex MCP server (SSE) listening on http://localhost:${port}/sse`);
  });

  return sessions;
}
