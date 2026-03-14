import { validateToken } from "../auth/tokens";
import { loadConfig } from "../config";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";

export interface AuthSession {
  repoIds: number[] | null; // null = full access (no tokens exist)
  authenticated: boolean;
}

/**
 * Check if any access tokens exist in the database.
 */
async function hasTokens(repoRoot: string): Promise<boolean> {
  const config = await loadConfig(repoRoot);
  if (config.store === "pg") {
    const rows = (await pgUnsafe("SELECT 1 FROM access_tokens LIMIT 1")) as unknown[];
    return rows.length > 0;
  } else {
    const db = await getSqlite(repoRoot);
    const row = db.prepare("SELECT 1 FROM access_tokens LIMIT 1").get();
    return row != null;
  }
}

/**
 * Authenticate a session from a bearer token.
 * Returns the session with scoped repo IDs, or null if auth fails.
 */
export async function authenticateSession(
  repoRoot: string,
  token: string | undefined,
): Promise<AuthSession | null> {
  const tokensExist = await hasTokens(repoRoot);

  if (!tokensExist) {
    // No tokens configured — full access, no auth needed
    return { repoIds: null, authenticated: false };
  }

  if (!token) {
    // Tokens exist but none provided — deny
    return null;
  }

  const repoIds = await validateToken(repoRoot, token);
  if (repoIds === null) {
    // Invalid/expired/revoked
    return null;
  }

  return { repoIds, authenticated: true };
}

/**
 * Validate that a repoPath is within the session's scope.
 */
export async function validateRepoScope(
  repoRoot: string,
  repoPath: string | undefined,
  session: AuthSession,
): Promise<boolean> {
  if (session.repoIds === null) return true; // full access
  if (!repoPath || repoPath === repoRoot) {
    // Look up the default repo's ID and check it against token scope
    const config = await loadConfig(repoRoot);
    if (config.store === "pg") {
      const rows = (await pgUnsafe("SELECT id FROM repos WHERE root_path = $1", [repoRoot])) as {
        id: string;
      }[];
      if (rows.length === 0) return false;
      return session.repoIds.includes(parseInt(rows[0].id));
    } else {
      const db = await getSqlite(repoRoot);
      const row = db.prepare("SELECT id FROM repos WHERE root_path = ?").get(repoRoot) as {
        id: number;
      } | null;
      if (!row) return false;
      return session.repoIds.includes(row.id);
    }
  }

  // Look up the repo ID for the given path
  const config = await loadConfig(repoRoot);
  if (config.store === "pg") {
    const rows = (await pgUnsafe("SELECT id FROM repos WHERE root_path = $1", [repoPath])) as {
      id: string;
    }[];
    if (rows.length === 0) return false;
    return session.repoIds.includes(parseInt(rows[0].id));
  } else {
    const db = await getSqlite(repoRoot);
    const row = db.prepare("SELECT id FROM repos WHERE root_path = ?").get(repoPath) as {
      id: number;
    } | null;
    if (!row) return false;
    return session.repoIds.includes(row.id);
  }
}
