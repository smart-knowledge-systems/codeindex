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
 */
export async function startSSE(server: McpServer, port: number): Promise<void> {
  let sseTransport: SSEServerTransport | null = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/sse") {
      sseTransport = new SSEServerTransport("/message", res);
      await server.connect(sseTransport);
    } else if (req.method === "POST" && req.url === "/message") {
      if (!sseTransport) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("No SSE connection established. GET /sse first.");
        return;
      }
      await sseTransport.handlePostMessage(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });

  httpServer.listen(port, () => {
    console.error(`codeindex MCP server (SSE) listening on http://localhost:${port}/sse`);
  });
}
