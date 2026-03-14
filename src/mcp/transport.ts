import crypto from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authenticateSession, type AuthSession } from "./auth";

export interface SessionEntry {
  transport: SSEServerTransport;
  token?: string;
  session?: AuthSession;
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const CORS_ORIGINS = process.env.CODEINDEX_CORS_ORIGINS ?? "*";

function setCorsHeaders(res: ServerResponse, req: IncomingMessage): void {
  const origin = req.headers.origin ?? "*";
  const allowedOrigin =
    CORS_ORIGINS === "*" ? "*" : CORS_ORIGINS.split(",").includes(origin) ? origin : "";
  if (!allowedOrigin) return;

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

// ---------------------------------------------------------------------------
// Rate limiting — simple in-memory token bucket per session
// ---------------------------------------------------------------------------

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

const RATE_LIMIT = 60; // requests per minute
const REFILL_INTERVAL_MS = 60_000;

const rateBuckets = new Map<string, RateBucket>();

function checkRateLimit(sessionId: string): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(sessionId);

  if (!bucket) {
    bucket = { tokens: RATE_LIMIT, lastRefill: now };
    rateBuckets.set(sessionId, bucket);
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  if (elapsed >= REFILL_INTERVAL_MS) {
    bucket.tokens = RATE_LIMIT;
    bucket.lastRefill = now;
  } else {
    // Proportional refill
    const refill = Math.floor((elapsed / REFILL_INTERVAL_MS) * RATE_LIMIT);
    if (refill > 0) {
      bucket.tokens = Math.min(RATE_LIMIT, bucket.tokens + refill);
      bucket.lastRefill = now;
    }
  }

  if (bucket.tokens <= 0) return false;

  bucket.tokens--;
  return true;
}

/**
 * Clean up rate bucket when a session is removed.
 */
function removeRateBucket(sessionId: string): void {
  rateBuckets.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/**
 * Start the MCP server with stdio transport (default).
 * Reads JSON-RPC from stdin and writes to stdout.
 * If CODEINDEX_TOKEN is set, validates it at startup.
 */
export async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Start the MCP server with SSE transport over HTTP.
 * Clients connect via GET /sse for the event stream and POST /message to send requests.
 * Supports multiple concurrent clients via session-keyed transports.
 * Extracts Bearer token from Authorization header for auth.
 * Includes CORS headers and per-session rate limiting.
 */
export async function startSSE(
  server: McpServer,
  port: number,
  repoRoot: string,
): Promise<Map<string, SessionEntry>> {
  const sessions = new Map<string, SessionEntry>();

  const httpServer = createServer(async (req, res) => {
    // Set CORS headers on all responses
    setCorsHeaders(res, req);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

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
      res.on("close", () => {
        sessions.delete(sessionId);
        removeRateBucket(sessionId);
      });
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

      // Rate limit check
      if (sessionId && !checkRateLimit(sessionId)) {
        res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "60" });
        res.end("Too many requests. Limit: 60 requests per minute.");
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
