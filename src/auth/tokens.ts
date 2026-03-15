import { randomUUID } from "crypto";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { loadConfig } from "../config";
import { logEvent } from "../logging";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(token);
  return hasher.digest("hex");
}

/** Check whether a token record is expired relative to the given timestamp. */
function isExpired(expiresAt: string | null, now: Date): boolean {
  return expiresAt != null && new Date(expiresAt) < now;
}

/** Map a raw pg token row to TokenInfo. */
function pgRowToTokenInfo(r: {
  id: string;
  name: string;
  created_at: string;
  expires_at: string | null;
  revoked: boolean;
  repo_ids: number[] | null;
}): TokenInfo {
  return {
    id: parseInt(r.id),
    name: r.name,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revoked: r.revoked,
    repoIds: r.repo_ids?.filter((id) => id !== null) ?? [],
  };
}

/** Map a raw sqlite token row to TokenInfo, using a pre-built access map. */
function sqliteRowToTokenInfo(
  t: { id: number; name: string; created_at: string; expires_at: string | null; revoked: number },
  accessByToken: Map<number, number[]>,
): TokenInfo {
  return {
    id: t.id,
    name: t.name,
    createdAt: t.created_at,
    expiresAt: t.expires_at,
    revoked: !!t.revoked,
    repoIds: accessByToken.get(t.id) ?? [],
  };
}

/** Group access rows into a Map<tokenId, repoId[]>. */
function buildAccessMap(rows: { token_id: number; repo_id: number }[]): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (const row of rows) {
    let list = result.get(row.token_id);
    if (!list) {
      list = [];
      result.set(row.token_id, list);
    }
    list.push(row.repo_id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenInfo {
  id: number;
  name: string;
  createdAt: string;
  expiresAt: string | null;
  revoked: boolean;
  repoIds: number[];
}

// ---------------------------------------------------------------------------
// Impure boundary — database operations
// ---------------------------------------------------------------------------

/**
 * Create a new access token scoped to the given repos.
 * Returns the plaintext token (only shown once).
 */
export async function createToken(
  repoRoot: string,
  name: string,
  repoIds: number[],
  expiresAt?: string,
): Promise<string> {
  const config = await loadConfig(repoRoot);
  const plaintext = randomUUID();
  const hash = hashToken(plaintext);

  if (config.store === "pg") {
    await pgUnsafe("BEGIN");
    try {
      const rows = (await pgUnsafe(
        `INSERT INTO access_tokens (token_hash, name, expires_at) VALUES ($1, $2, $3) RETURNING id`,
        [hash, name, expiresAt ?? null],
      )) as { id: string }[];
      const tokenId = parseInt(rows[0].id);
      for (const repoId of repoIds) {
        await pgUnsafe(`INSERT INTO token_repo_access (token_id, repo_id) VALUES ($1, $2)`, [
          tokenId,
          repoId,
        ]);
      }
      await pgUnsafe("COMMIT");
    } catch (err) {
      await pgUnsafe("ROLLBACK");
      logEvent({
        event: "auth.token.create",
        outcome: "error",
        "error.type": (err as Error).name,
        "error.message": (err as Error).message,
        "error.retriable": false,
        tokenName: name,
        repoCount: repoIds.length,
      });
      throw err;
    }
  } else {
    const db = await getSqlite(repoRoot);
    db.transaction(() => {
      const result = db
        .prepare(`INSERT INTO access_tokens (token_hash, name, expires_at) VALUES (?, ?, ?)`)
        .run(hash, name, expiresAt ?? null);
      const tokenId = Number(result.lastInsertRowid);
      const insertAccess = db.prepare(
        `INSERT INTO token_repo_access (token_id, repo_id) VALUES (?, ?)`,
      );
      for (const repoId of repoIds) {
        insertAccess.run(tokenId, repoId);
      }
    })();
  }

  logEvent({
    event: "auth.token.create",
    outcome: "success",
    tokenName: name,
    repoCount: repoIds.length,
    hasExpiry: expiresAt != null,
  });

  return plaintext;
}

/**
 * Validate a token and return the repo IDs it has access to.
 * Returns null if the token is invalid, expired, or revoked.
 */
export async function validateToken(
  repoRoot: string,
  token: string,
  now: Date = new Date(),
): Promise<number[] | null> {
  const config = await loadConfig(repoRoot);
  const hash = hashToken(token);

  const reject = (reason: string): null => {
    logEvent({ event: "auth.token.validate", outcome: "rejected", reason });
    return null;
  };

  if (config.store === "pg") {
    const rows = (await pgUnsafe(
      `SELECT id, revoked, expires_at FROM access_tokens WHERE token_hash = $1`,
      [hash],
    )) as { id: string; revoked: boolean; expires_at: string | null }[];
    if (rows.length === 0) return reject("not_found");

    const row = rows[0];
    if (row.revoked) return reject("revoked");
    if (isExpired(row.expires_at, now)) return reject("expired");

    const accessRows = (await pgUnsafe(
      `SELECT repo_id FROM token_repo_access WHERE token_id = $1`,
      [parseInt(row.id)],
    )) as { repo_id: string }[];

    logEvent({ event: "auth.token.validate", outcome: "success" });
    return accessRows.map((r) => parseInt(r.repo_id));
  }

  const db = await getSqlite(repoRoot);
  const row = db
    .prepare(`SELECT id, revoked, expires_at FROM access_tokens WHERE token_hash = ?`)
    .get(hash) as { id: number; revoked: number; expires_at: string | null } | null;
  if (!row) return reject("not_found");
  if (row.revoked) return reject("revoked");
  if (isExpired(row.expires_at, now)) return reject("expired");

  const accessRows = db
    .prepare(`SELECT repo_id FROM token_repo_access WHERE token_id = ?`)
    .all(row.id) as { repo_id: number }[];

  logEvent({ event: "auth.token.validate", outcome: "success" });
  return accessRows.map((r) => r.repo_id);
}

/**
 * List all tokens (without hashes).
 */
export async function listTokens(repoRoot: string): Promise<TokenInfo[]> {
  const config = await loadConfig(repoRoot);

  let tokens: TokenInfo[];

  if (config.store === "pg") {
    const rows = (await pgUnsafe(
      `SELECT t.id, t.name, t.created_at, t.expires_at, t.revoked,
              array_agg(tra.repo_id) AS repo_ids
       FROM access_tokens t
       LEFT JOIN token_repo_access tra ON tra.token_id = t.id
       GROUP BY t.id ORDER BY t.id`,
    )) as {
      id: string;
      name: string;
      created_at: string;
      expires_at: string | null;
      revoked: boolean;
      repo_ids: number[] | null;
    }[];
    tokens = rows.map(pgRowToTokenInfo);
  } else {
    const db = await getSqlite(repoRoot);
    const tokenRows = db
      .prepare(`SELECT id, name, created_at, expires_at, revoked FROM access_tokens ORDER BY id`)
      .all() as {
      id: number;
      name: string;
      created_at: string;
      expires_at: string | null;
      revoked: number;
    }[];
    const allAccess = db.prepare(`SELECT token_id, repo_id FROM token_repo_access`).all() as {
      token_id: number;
      repo_id: number;
    }[];
    const accessByToken = buildAccessMap(allAccess);
    tokens = tokenRows.map((t) => sqliteRowToTokenInfo(t, accessByToken));
  }

  logEvent({ event: "auth.token.list", tokenCount: tokens.length });
  return tokens;
}

/**
 * Revoke a token by ID.
 */
export async function revokeToken(repoRoot: string, tokenId: number): Promise<void> {
  const config = await loadConfig(repoRoot);
  if (config.store === "pg") {
    await pgUnsafe(`UPDATE access_tokens SET revoked = true WHERE id = $1`, [tokenId]);
  } else {
    const db = await getSqlite(repoRoot);
    db.prepare(`UPDATE access_tokens SET revoked = 1 WHERE id = ?`).run(tokenId);
  }

  logEvent({ event: "auth.token.revoke", tokenId });
}

/**
 * Get scoped repo IDs from a token (via env var or explicit).
 * Returns null if no token is set (full access).
 */
export async function getScopedRepoIds(
  repoRoot: string,
  token?: string | null,
): Promise<number[] | null> {
  const resolvedToken = token ?? process.env.CODEINDEX_TOKEN ?? null;
  if (!resolvedToken) return null;
  // Invalid/expired/revoked token should deny access (empty array),
  // not grant full access (null)
  return (await validateToken(repoRoot, resolvedToken)) ?? [];
}
