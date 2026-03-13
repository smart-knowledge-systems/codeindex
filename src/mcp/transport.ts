import crypto from "crypto";
import { createServer } from "http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Start the MCP server with stdio transport (default).
 * Reads JSON-RPC from stdin and writes to stdout.
 */
export async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Start the MCP server with SSE transport over HTTP.
 * Clients connect via GET /sse for the event stream and POST /message to send requests.
 * Supports multiple concurrent clients via session-keyed transports.
 */
export async function startSSE(server: McpServer, port: number): Promise<void> {
  const sessions = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/sse") {
      const sessionId = crypto.randomUUID();
      const transport = new SSEServerTransport(`/message?sessionId=${sessionId}`, res);
      sessions.set(sessionId, transport);
      res.on("close", () => sessions.delete(sessionId));
      await server.connect(transport);
    } else if (req.method === "POST" && req.url?.startsWith("/message")) {
      const url = new URL(req.url, `http://localhost:${port}`);
      const sessionId = url.searchParams.get("sessionId");
      const transport = sessionId ? sessions.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Unknown or missing session. GET /sse first.");
        return;
      }
      await transport.handlePostMessage(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });

  httpServer.listen(port, () => {
    console.error(`codeindex MCP server (SSE) listening on http://localhost:${port}/sse`);
  });
}
