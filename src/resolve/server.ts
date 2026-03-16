// Daemon file server — /resolve endpoint
// Standalone HTTP handler for serving file resolution requests

import { logEvent } from "../logging";
import { resolve } from "./resolver";
import { isSharingEnabled } from "./sharing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResolveRequestBody {
  origin_url: string;
  commit_hash: string;
  file_path: string;
  requester_id: string;
}

// ---------------------------------------------------------------------------
// Rate limiting — in-memory counter per requester
// ---------------------------------------------------------------------------

const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateBucket>();

function checkRateLimit(requesterId: string): boolean {
  const now = Date.now();
  const bucket = rateLimitMap.get(requesterId);

  if (!bucket || now >= bucket.resetAt) {
    rateLimitMap.set(requesterId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (bucket.count >= RATE_LIMIT_MAX) {
    return false;
  }

  bucket.count++;
  return true;
}

// Periodic cleanup of stale buckets
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitMap) {
    if (now >= bucket.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

// ---------------------------------------------------------------------------
// Auth verification
// ---------------------------------------------------------------------------

const authCache = new Map<string, { userId: string; expiresAt: number }>();
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;

// Periodic cleanup of expired auth cache entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of authCache) {
    if (now >= entry.expiresAt) {
      authCache.delete(key);
    }
  }
}, AUTH_CACHE_TTL_MS);

async function verifyToken(authHeader: string | null): Promise<string | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  if (!token) return null;

  const cached = authCache.get(token);
  if (cached && Date.now() < cached.expiresAt) return cached.userId;

  try {
    const { CloudClient } = await import("../cloud/client");
    const client = new CloudClient();
    client.setToken(token);
    const status = await client.getStatus();
    authCache.set(token, { userId: status.user.id, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    return status.user.id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleResolveRequest(req: Request): Promise<Response> {
  // Only accept POST
  if (req.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  // Auth check
  const userId = await verifyToken(req.headers.get("Authorization"));
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Parse body
  let body: ResolveRequestBody;
  try {
    body = (await req.json()) as ResolveRequestBody;
  } catch {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }

  const { origin_url, commit_hash, file_path, requester_id } = body;

  if (!origin_url || !commit_hash || !file_path || !requester_id) {
    return Response.json(
      { error: "missing required fields: origin_url, commit_hash, file_path, requester_id" },
      { status: 400 },
    );
  }

  // Rate limiting
  if (!checkRateLimit(userId)) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }

  // Audit log — use verified userId; sanitize all body fields to prevent log injection
  const safeRequesterId = requester_id.replace(/[\r\n]/g, " ");
  const safeOriginUrl = origin_url.replace(/[\r\n]/g, " ");
  const safeCommitHash = commit_hash.replace(/[\r\n]/g, " ");
  const safeFilePath = file_path.replace(/[\r\n]/g, " ");
  console.error(
    `[resolve] ${new Date().toISOString()} userId=${userId} requester=${safeRequesterId} origin=${safeOriginUrl} commit=${safeCommitHash} file=${safeFilePath}`,
  );

  // Sharing check
  const sharingEnabled = await isSharingEnabled(origin_url);
  if (!sharingEnabled) {
    logEvent({
      event: "infra.resolve.sharing_denied",
      origin_url,
      requester_id,
    });
    return Response.json({ error: "sharing not enabled for this repository" }, { status: 403 });
  }

  // Resolve using local strategies only (1-3, no recursive relay)
  // Try strategies 1, 2, 3 sequentially
  for (const strategy of [1, 2, 3]) {
    const result = await resolve(origin_url, commit_hash, file_path, strategy);
    if ("content" in result) {
      return Response.json({
        content: result.content,
        strategy: result.strategy,
      });
    }
  }

  return Response.json({ error: "file not available locally" }, { status: 404 });
}

// ---------------------------------------------------------------------------
// Export for wiring into daemon (placeholder for future integration)
// ---------------------------------------------------------------------------

export async function registerResolveEndpoint(): Promise<void> {
  // This will be wired into the daemon server in a future task.
  // For now, handleResolveRequest is the primary export.
  logEvent({ event: "infra.resolve.endpoint_registered" });
}
