/**
 * SQLite backend for GlobalDedupStore. Opens its own ~/.codeindex/global.db
 * (separate from any per-repo .codeindex.db) so the cache is shared across
 * every repo on this machine. Uses sqlite-vec for embedding storage.
 */

import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import path from "path";
import os from "os";
import { existsSync, mkdirSync } from "fs";
import { applyGlobalSqliteMigrations, ensureGlobalSqliteVecTables } from "../db/migrate";
import { serializeEmbedding, deserializeEmbedding } from "../db/util";
import type { CodeindexConfig } from "../search/types";
import type {
  GlobalDedupStore,
  BlobKey,
  BlobRecord,
  PackageKey,
  PackageRecord,
  PackageFileEntry,
  PackageMeta,
  DedupStats,
} from "./global-store";

const HOMEBREW_SQLITE = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";

function defaultGlobalDbPath(): string {
  return path.join(os.homedir(), ".codeindex", "global.db");
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export async function openSqliteGlobalStore(config: CodeindexConfig): Promise<GlobalDedupStore> {
  // Allow override via dedup.sqlitePath if provided (added in commit 4).
  const overridePath = (config as CodeindexConfig & { dedup?: { sqlitePath?: string } }).dedup
    ?.sqlitePath;
  const dbPath = overridePath ?? defaultGlobalDbPath();
  ensureParentDir(dbPath);

  if (process.platform === "darwin" && existsSync(HOMEBREW_SQLITE)) {
    Database.setCustomSQLite(HOMEBREW_SQLITE);
  }

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  sqliteVec.load(db);

  const result = await applyGlobalSqliteMigrations(db);
  if (result.tag === "err") throw result.error;

  ensureGlobalSqliteVecTables(db, config.embedding.dimensions);

  return new SqliteGlobalStore(db);
}

class SqliteGlobalStore implements GlobalDedupStore {
  // Prepared statements are lazily built on first use to keep construction cheap.
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async lookupBlob(key: BlobKey): Promise<BlobRecord | null> {
    const row = this.db
      .prepare(
        `SELECT id, skeleton, skeleton_entries
         FROM content_blobs
         WHERE content_hash = ? AND provider = ? AND model = ? AND dimensions = ?`,
      )
      .get(key.contentHash, key.provider, key.model, key.dimensions) as
      | { id: number; skeleton: string | null; skeleton_entries: string | null }
      | undefined;
    if (!row) return null;

    const embRow = this.db
      .prepare(`SELECT embedding FROM content_blob_embeddings WHERE blob_id = ?`)
      .get(row.id) as { embedding: Uint8Array } | undefined;
    if (!embRow) return null;

    return {
      skeleton: row.skeleton,
      skeletonEntries: row.skeleton_entries,
      embedding: deserializeEmbedding(Buffer.from(embRow.embedding)),
    };
  }

  async lookupBlobs(
    hashes: string[],
    provider: string,
    model: string,
    dimensions: number,
  ): Promise<Map<string, BlobRecord>> {
    const result = new Map<string, BlobRecord>();
    if (hashes.length === 0) return result;

    // SQLite parameter limit is 999 by default — chunk to be safe.
    const CHUNK = 500;
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const chunk = hashes.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT cb.id, cb.content_hash, cb.skeleton, cb.skeleton_entries, cbe.embedding
           FROM content_blobs cb
           JOIN content_blob_embeddings cbe ON cbe.blob_id = cb.id
           WHERE cb.provider = ? AND cb.model = ? AND cb.dimensions = ?
             AND cb.content_hash IN (${placeholders})`,
        )
        .all(provider, model, dimensions, ...chunk) as Array<{
        id: number;
        content_hash: string;
        skeleton: string | null;
        skeleton_entries: string | null;
        embedding: Uint8Array;
      }>;
      for (const row of rows) {
        result.set(row.content_hash, {
          skeleton: row.skeleton,
          skeletonEntries: row.skeleton_entries,
          embedding: deserializeEmbedding(Buffer.from(row.embedding)),
        });
      }
    }
    return result;
  }

  async writeBlob(key: BlobKey, record: BlobRecord): Promise<void> {
    const insertBlob = this.db.prepare(
      `INSERT INTO content_blobs (content_hash, provider, model, dimensions, skeleton, skeleton_entries)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_hash, provider, model, dimensions) DO UPDATE SET
         ref_count = ref_count + 1
       RETURNING id`,
    );
    const deleteEmb = this.db.prepare(`DELETE FROM content_blob_embeddings WHERE blob_id = ?`);
    const insertEmb = this.db.prepare(
      `INSERT INTO content_blob_embeddings (blob_id, embedding) VALUES (?, ?)`,
    );

    this.db.transaction(() => {
      const row = insertBlob.get(
        key.contentHash,
        key.provider,
        key.model,
        key.dimensions,
        record.skeleton,
        record.skeletonEntries,
      ) as { id: number };

      // Only write the embedding if no row existed yet for this blob_id.
      const existing = this.db
        .prepare(`SELECT 1 AS one FROM content_blob_embeddings WHERE blob_id = ?`)
        .get(row.id) as { one: number } | undefined;
      if (!existing) {
        deleteEmb.run(row.id);
        insertEmb.run(row.id, serializeEmbedding(record.embedding));
      }
    })();
  }

  async lookupPackage(key: PackageKey): Promise<PackageRecord | null> {
    const row = this.db
      .prepare(
        `SELECT id, ecosystem, name, version
         FROM packages
         WHERE tree_hash = ? AND provider = ? AND model = ? AND dimensions = ?`,
      )
      .get(key.treeHash, key.provider, key.model, key.dimensions) as
      | { id: number; ecosystem: string; name: string; version: string }
      | undefined;
    return row ?? null;
  }

  async listPackageFiles(packageId: number): Promise<PackageFileEntry[]> {
    const rows = this.db
      .prepare(`SELECT relpath, content_hash FROM package_files WHERE package_id = ?`)
      .all(packageId) as Array<{ relpath: string; content_hash: string }>;
    return rows.map((r) => ({ relpath: r.relpath, contentHash: r.content_hash }));
  }

  async writePackage(
    key: PackageKey,
    meta: PackageMeta,
    files: PackageFileEntry[],
  ): Promise<number> {
    const insertPkg = this.db.prepare(
      `INSERT INTO packages (ecosystem, name, version, tree_hash, provider, model, dimensions)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tree_hash, provider, model, dimensions) DO UPDATE SET
         indexed_at = datetime('now')
       RETURNING id`,
    );
    const insertFile = this.db.prepare(
      `INSERT INTO package_files (package_id, relpath, content_hash)
       VALUES (?, ?, ?)
       ON CONFLICT (package_id, relpath) DO UPDATE SET content_hash = excluded.content_hash`,
    );

    let pkgId = 0;
    this.db.transaction(() => {
      const row = insertPkg.get(
        meta.ecosystem,
        meta.name,
        meta.version,
        key.treeHash,
        key.provider,
        key.model,
        key.dimensions,
      ) as { id: number };
      pkgId = row.id;
      for (const f of files) {
        insertFile.run(pkgId, f.relpath, f.contentHash);
      }
    })();
    return pkgId;
  }

  async linkRepoPackage(repoRoot: string, packageId: number, mountPath: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO repo_packages (repo_root, package_id, mount_path)
         VALUES (?, ?, ?)
         ON CONFLICT (repo_root, package_id, mount_path) DO NOTHING`,
      )
      .run(repoRoot, packageId, mountPath);
  }

  async stats(): Promise<DedupStats> {
    const blob = this.db.prepare(`SELECT COUNT(*) AS n FROM content_blobs`).get() as { n: number };
    const pkg = this.db.prepare(`SELECT COUNT(*) AS n FROM packages`).get() as { n: number };
    const links = this.db.prepare(`SELECT COUNT(*) AS n FROM repo_packages`).get() as {
      n: number;
    };
    const ecoRows = this.db
      .prepare(`SELECT ecosystem, COUNT(*) AS n FROM packages GROUP BY ecosystem ORDER BY n DESC`)
      .all() as Array<{ ecosystem: string; n: number }>;
    const provRows = this.db
      .prepare(
        `SELECT provider, model, dimensions, COUNT(*) AS n
         FROM content_blobs
         GROUP BY provider, model, dimensions
         ORDER BY n DESC`,
      )
      .all() as Array<{ provider: string; model: string; dimensions: number; n: number }>;
    let storageBytes: number | null = null;
    try {
      const filename = (this.db.prepare("PRAGMA database_list").all() as Array<{ file: string }>)[0]
        ?.file;
      if (filename) {
        const file = Bun.file(filename);
        storageBytes = file.size;
      }
    } catch {
      /* size lookup is best-effort */
    }
    return {
      blobCount: blob.n,
      packageCount: pkg.n,
      repoLinkCount: links.n,
      ecosystems: ecoRows.map((r) => ({ ecosystem: r.ecosystem, count: r.n })),
      providers: provRows.map((r) => ({
        provider: r.provider,
        model: r.model,
        dimensions: r.dimensions,
        blobs: r.n,
      })),
      storageBytes,
    };
  }

  async unlinkRepoPackages(repoRoot: string): Promise<number> {
    const before = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM repo_packages WHERE repo_root = ?`)
        .get(repoRoot) as { n: number }
    ).n;
    this.db.prepare(`DELETE FROM repo_packages WHERE repo_root = ?`).run(repoRoot);
    return before;
  }

  async listOrphanedPackageIds(): Promise<number[]> {
    const rows = this.db
      .prepare(
        `SELECT id FROM packages
         WHERE id NOT IN (SELECT DISTINCT package_id FROM repo_packages)`,
      )
      .all() as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  async listLivePackageBlobHashes(excludePackageIds: number[]): Promise<string[]> {
    if (excludePackageIds.length === 0) {
      const rows = this.db
        .prepare(`SELECT DISTINCT content_hash FROM package_files`)
        .all() as Array<{ content_hash: string }>;
      return rows.map((r) => r.content_hash);
    }
    // Chunk to keep parameter count safe.
    const live = new Set<string>();
    const CHUNK = 500;
    for (let i = 0; i < excludePackageIds.length; i += CHUNK) {
      const chunk = excludePackageIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT DISTINCT content_hash FROM package_files
           WHERE package_id NOT IN (${placeholders})`,
        )
        .all(...chunk) as Array<{ content_hash: string }>;
      for (const r of rows) live.add(r.content_hash);
    }
    return Array.from(live);
  }

  async deletePackages(packageIds: number[]): Promise<void> {
    if (packageIds.length === 0) return;
    const stmt = this.db.prepare(`DELETE FROM packages WHERE id = ?`);
    this.db.transaction(() => {
      for (const id of packageIds) stmt.run(id);
    })();
  }

  async countBlobsExcept(liveHashes: Set<string>): Promise<number> {
    if (liveHashes.size === 0) {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM content_blobs`).get() as { n: number };
      return row.n;
    }
    // Materialise live set to a temp table for an O(1) anti-join.
    return this.withLiveHashTable(liveHashes, () => {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM content_blobs cb
           WHERE cb.content_hash NOT IN (SELECT h FROM _gc_live)`,
        )
        .get() as { n: number };
      return row.n;
    });
  }

  async sweepOrphanedBlobs(): Promise<number | null> {
    // SQLite global store still keeps its own content_blobs table; the
    // unified file_blobs sweep only applies to the PG backend until the
    // SQLite machine-wide dedup unification follow-up lands.
    return null;
  }

  async deleteBlobsExcept(liveHashes: Set<string>): Promise<number> {
    return this.withLiveHashTable(liveHashes, () => {
      // Delete embeddings first (FK), then blobs.
      const before = (
        this.db.prepare(`SELECT COUNT(*) AS n FROM content_blobs`).get() as { n: number }
      ).n;
      this.db.transaction(() => {
        this.db
          .prepare(
            `DELETE FROM content_blob_embeddings
             WHERE blob_id IN (
               SELECT id FROM content_blobs
               WHERE content_hash NOT IN (SELECT h FROM _gc_live)
             )`,
          )
          .run();
        this.db
          .prepare(
            `DELETE FROM content_blobs
             WHERE content_hash NOT IN (SELECT h FROM _gc_live)`,
          )
          .run();
      })();
      const after = (
        this.db.prepare(`SELECT COUNT(*) AS n FROM content_blobs`).get() as { n: number }
      ).n;
      return before - after;
    });
  }

  /**
   * Materialise the live-hash set into a temporary table so anti-joins run in
   * one statement instead of N parameter binds. Cleaned up unconditionally.
   */
  private withLiveHashTable<T>(liveHashes: Set<string>, fn: () => T): T {
    this.db.exec(`CREATE TEMP TABLE IF NOT EXISTS _gc_live (h TEXT PRIMARY KEY)`);
    this.db.exec(`DELETE FROM _gc_live`);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO _gc_live (h) VALUES (?)`);
    this.db.transaction(() => {
      for (const h of liveHashes) insert.run(h);
    })();
    try {
      return fn();
    } finally {
      this.db.exec(`DROP TABLE IF EXISTS _gc_live`);
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
