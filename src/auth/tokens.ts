import { randomUUID } from "crypto";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { loadConfig } from "../config";

function hashToken(token: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(token);
  return hasher.digest("hex");
}

export interface TokenInfo {
  id: number;
  name: string;
  createdAt: string;
  expiresAt: string | null;
  revoked: boolean;
  repoIds: number[];
}

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

  return plaintext;
}

/**
 * Validate a token and return the repo IDs it has access to.
 * Returns null if the token is invalid, expired, or revoked.
 */
export async function validateToken(repoRoot: string, token: string): Promise<number[] | null> {
  const config = await loadConfig(repoRoot);
  const hash = hashToken(token);

  if (config.store === "pg") {
    const rows = (await pgUnsafe(
      `SELECT id, revoked, expires_at FROM access_tokens WHERE token_hash = $1`,
      [hash],
    )) as { id: string; revoked: boolean; expires_at: string | null }[];
    if (rows.length === 0) return null;

    const row = rows[0];
    if (row.revoked) return null;
    if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

    const accessRows = (await pgUnsafe(
      `SELECT repo_id FROM token_repo_access WHERE token_id = $1`,
      [parseInt(row.id)],
    )) as { repo_id: string }[];
    return accessRows.map((r) => parseInt(r.repo_id));
  } else {
    const db = await getSqlite(repoRoot);
    const row = db
      .prepare(`SELECT id, revoked, expires_at FROM access_tokens WHERE token_hash = ?`)
      .get(hash) as { id: number; revoked: number; expires_at: string | null } | null;
    if (!row) return null;
    if (row.revoked) return null;
    if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

    const accessRows = db
      .prepare(`SELECT repo_id FROM token_repo_access WHERE token_id = ?`)
      .all(row.id) as { repo_id: number }[];
    return accessRows.map((r) => r.repo_id);
  }
}

/**
 * List all tokens (without hashes).
 */
export async function listTokens(repoRoot: string): Promise<TokenInfo[]> {
  const config = await loadConfig(repoRoot);

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
    return rows.map((r) => ({
      id: parseInt(r.id),
      name: r.name,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      revoked: r.revoked,
      repoIds: r.repo_ids?.filter((id) => id !== null) ?? [],
    }));
  } else {
    const db = await getSqlite(repoRoot);
    const tokens = db
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
    const accessByToken = new Map<number, number[]>();
    for (const row of allAccess) {
      const list = accessByToken.get(row.token_id) ?? [];
      list.push(row.repo_id);
      accessByToken.set(row.token_id, list);
    }
    return tokens.map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.created_at,
      expiresAt: t.expires_at,
      revoked: !!t.revoked,
      repoIds: accessByToken.get(t.id) ?? [],
    }));
  }
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
}

/**
 * Get scoped repo IDs from a token (via env var or explicit).
 * Returns null if no token is set (full access).
 */
export async function getScopedRepoIds(repoRoot: string): Promise<number[] | null> {
  const token = process.env.CODEINDEX_TOKEN;
  if (!token) return null;
  // Invalid/expired/revoked token should deny access (empty array),
  // not grant full access (null)
  return (await validateToken(repoRoot, token)) ?? [];
}
