import { validateToken } from "../auth/tokens";
import { getRepoIdByPath } from "../db/repo-lookup";
import { getStoreOps } from "../repo";

export interface AuthSession {
  repoIds: number[] | null; // null = full access (no tokens exist)
  authenticated: boolean;
}

/**
 * Check if any access tokens exist in the database.
 */
async function hasTokens(repoRoot: string): Promise<boolean> {
  const { ops } = await getStoreOps(repoRoot);
  const rows = await ops.query<{ "1": number }>("SELECT 1 FROM access_tokens LIMIT 1");
  return rows.length > 0;
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

  const targetPath = !repoPath || repoPath === repoRoot ? repoRoot : repoPath;
  const repoId = await getRepoIdByPath(repoRoot, targetPath);
  if (repoId === null) return false;
  return session.repoIds.includes(repoId);
}
