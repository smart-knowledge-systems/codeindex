/**
 * Postgres backend for GlobalDedupStore. Reuses the per-repo pg connection
 * pool from src/db/pg.ts. Blob storage now lives on the unified file_blobs
 * table (per-repo migration 0010); packages / package_files / repo_packages
 * still live in the global namespace and are versioned separately via
 * global_schema_version (see migrations/global/*).
 *
 * The legacy content_blobs table (migrations/global/0001) is no longer read
 * or written here; migrations/global/0002 drops it on existing deployments.
 * The blob ref_count semantic is gone — file_blobs lifetime is governed by
 * the existence of repo_files / package_files entries.
 */

import { getPg } from "../db/pg";
import { applyGlobalPgMigrations } from "../db/migrate";
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

export async function openPgGlobalStore(
  _config: CodeindexConfig, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<GlobalDedupStore> {
  const result = await applyGlobalPgMigrations();
  if (result.tag === "err") throw result.error;
  return new PgGlobalStore();
}

class PgGlobalStore implements GlobalDedupStore {
  async lookupBlob(key: BlobKey): Promise<BlobRecord | null> {
    const pg = await getPg();
    const rows = (await pg.unsafe(
      `SELECT skeleton, skeleton_entries, embedding::text AS embedding
       FROM file_blobs
       WHERE content_hash = $1 AND provider = $2 AND model = $3 AND dimensions = $4`,
      [key.contentHash, key.provider, key.model, key.dimensions],
    )) as Array<{
      skeleton: string | null;
      skeleton_entries: string | null;
      embedding: string | null;
    }>;
    const row = rows.at(0);
    if (!row || !row.embedding) return null;
    return {
      skeleton: row.skeleton,
      skeletonEntries: row.skeleton_entries,
      embedding: parseVectorLiteral(row.embedding),
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
    const pg = await getPg();
    const rows = (await pg.unsafe(
      `SELECT content_hash, skeleton, skeleton_entries, embedding::text AS embedding
       FROM file_blobs
       WHERE provider = $1 AND model = $2 AND dimensions = $3
         AND content_hash = ANY($4::text[])`,
      [provider, model, dimensions, hashes],
    )) as Array<{
      content_hash: string;
      skeleton: string | null;
      skeleton_entries: string | null;
      embedding: string | null;
    }>;
    for (const row of rows) {
      if (!row.embedding) continue;
      result.set(row.content_hash, {
        skeleton: row.skeleton,
        skeletonEntries: row.skeleton_entries,
        embedding: parseVectorLiteral(row.embedding),
      });
    }
    return result;
  }

  async writeBlob(key: BlobKey, record: BlobRecord): Promise<void> {
    const pg = await getPg();
    // file_blobs is immutable by composite key — DO NOTHING on conflict.
    // The legacy ref_count column is gone; lifetime is governed by the
    // existence of repo_files / package_files entries (see dedup gc).
    await pg.unsafe(
      `INSERT INTO file_blobs
         (content_hash, provider, model, dimensions, skeleton, skeleton_entries, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
       ON CONFLICT (content_hash, provider, model, dimensions) DO NOTHING`,
      [
        key.contentHash,
        key.provider,
        key.model,
        key.dimensions,
        record.skeleton,
        record.skeletonEntries,
        toVectorLiteral(record.embedding),
      ],
    );
  }

  async lookupPackage(key: PackageKey): Promise<PackageRecord | null> {
    const pg = await getPg();
    const rows = (await pg.unsafe(
      `SELECT id, ecosystem, name, version
       FROM packages
       WHERE tree_hash = $1 AND provider = $2 AND model = $3 AND dimensions = $4`,
      [key.treeHash, key.provider, key.model, key.dimensions],
    )) as Array<{ id: number; ecosystem: string; name: string; version: string }>;
    return rows.at(0) ?? null;
  }

  async listPackageFiles(packageId: number): Promise<PackageFileEntry[]> {
    const pg = await getPg();
    const rows = (await pg.unsafe(
      `SELECT relpath, content_hash FROM package_files WHERE package_id = $1`,
      [packageId],
    )) as Array<{ relpath: string; content_hash: string }>;
    return rows.map((r) => ({ relpath: r.relpath, contentHash: r.content_hash }));
  }

  async writePackage(
    key: PackageKey,
    meta: PackageMeta,
    files: PackageFileEntry[],
  ): Promise<number> {
    const pg = await getPg();
    let pkgId = 0;
    await pg.begin(async (tx) => {
      const rows = (await tx.unsafe(
        `INSERT INTO packages
           (ecosystem, name, version, tree_hash, provider, model, dimensions)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tree_hash, provider, model, dimensions) DO UPDATE SET
           indexed_at = now()
         RETURNING id`,
        [
          meta.ecosystem,
          meta.name,
          meta.version,
          key.treeHash,
          key.provider,
          key.model,
          key.dimensions,
        ],
      )) as Array<{ id: number }>;
      pkgId = rows[0].id;
      for (const f of files) {
        await tx.unsafe(
          `INSERT INTO package_files (package_id, relpath, content_hash)
           VALUES ($1, $2, $3)
           ON CONFLICT (package_id, relpath) DO UPDATE SET content_hash = EXCLUDED.content_hash`,
          [pkgId, f.relpath, f.contentHash],
        );
      }
    });
    return pkgId;
  }

  async linkRepoPackage(repoRoot: string, packageId: number, mountPath: string): Promise<void> {
    const pg = await getPg();
    await pg.unsafe(
      `INSERT INTO repo_packages (repo_root, package_id, mount_path)
       VALUES ($1, $2, $3)
       ON CONFLICT (repo_root, package_id, mount_path) DO NOTHING`,
      [repoRoot, packageId, mountPath],
    );
  }

  async stats(): Promise<DedupStats> {
    const pg = await getPg();
    const blobRows = (await pg.unsafe(`SELECT COUNT(*)::int AS n FROM file_blobs`)) as Array<{
      n: number;
    }>;
    const pkgRows = (await pg.unsafe(`SELECT COUNT(*)::int AS n FROM packages`)) as Array<{
      n: number;
    }>;
    const linkRows = (await pg.unsafe(`SELECT COUNT(*)::int AS n FROM repo_packages`)) as Array<{
      n: number;
    }>;
    const ecoRows = (await pg.unsafe(
      `SELECT ecosystem, COUNT(*)::int AS n FROM packages GROUP BY ecosystem ORDER BY n DESC`,
    )) as Array<{ ecosystem: string; n: number }>;
    const provRows = (await pg.unsafe(
      `SELECT provider, model, dimensions, COUNT(*)::int AS n
       FROM file_blobs
       GROUP BY provider, model, dimensions
       ORDER BY n DESC`,
    )) as Array<{ provider: string; model: string; dimensions: number; n: number }>;
    return {
      blobCount: blobRows[0]?.n ?? 0,
      packageCount: pkgRows[0]?.n ?? 0,
      repoLinkCount: linkRows[0]?.n ?? 0,
      ecosystems: ecoRows.map((r) => ({ ecosystem: r.ecosystem, count: r.n })),
      providers: provRows.map((r) => ({
        provider: r.provider,
        model: r.model,
        dimensions: r.dimensions,
        blobs: r.n,
      })),
      storageBytes: null,
    };
  }

  async unlinkRepoPackages(repoRoot: string): Promise<number> {
    const pg = await getPg();
    const rows = (await pg.unsafe(
      `DELETE FROM repo_packages WHERE repo_root = $1 RETURNING package_id`,
      [repoRoot],
    )) as Array<{ package_id: number }>;
    return rows.length;
  }

  async listOrphanedPackageIds(): Promise<number[]> {
    const pg = await getPg();
    const rows = (await pg.unsafe(
      `SELECT id FROM packages
       WHERE id NOT IN (SELECT DISTINCT package_id FROM repo_packages)`,
    )) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  async listLivePackageBlobHashes(excludePackageIds: number[]): Promise<string[]> {
    const pg = await getPg();
    if (excludePackageIds.length === 0) {
      const rows = (await pg.unsafe(`SELECT DISTINCT content_hash FROM package_files`)) as Array<{
        content_hash: string;
      }>;
      return rows.map((r) => r.content_hash);
    }
    const rows = (await pg.unsafe(
      `SELECT DISTINCT content_hash FROM package_files
       WHERE NOT (package_id = ANY($1::int[]))`,
      [excludePackageIds],
    )) as Array<{ content_hash: string }>;
    return rows.map((r) => r.content_hash);
  }

  async deletePackages(packageIds: number[]): Promise<void> {
    if (packageIds.length === 0) return;
    const pg = await getPg();
    await pg.unsafe(`DELETE FROM packages WHERE id = ANY($1::int[])`, [packageIds]);
  }

  async countBlobsExcept(liveHashes: Set<string>): Promise<number> {
    const pg = await getPg();
    // file_blobs rows referenced by repo_files cannot be GC'd here without
    // an FK violation; exclude them from the candidate set. The simplified
    // NOT EXISTS sweep that supersedes this lives in `codeindex dedup gc`
    // (task 7).
    if (liveHashes.size === 0) {
      const rows = (await pg.unsafe(
        `SELECT COUNT(*)::int AS n FROM file_blobs fb
         WHERE NOT EXISTS (
           SELECT 1 FROM repo_files rf
           WHERE rf.content_hash = fb.content_hash
             AND rf.provider     = fb.provider
             AND rf.model        = fb.model
             AND rf.dimensions   = fb.dimensions
         )`,
      )) as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    }
    const rows = (await pg.unsafe(
      `SELECT COUNT(*)::int AS n FROM file_blobs fb
       WHERE NOT (fb.content_hash = ANY($1::text[]))
         AND NOT EXISTS (
           SELECT 1 FROM repo_files rf
           WHERE rf.content_hash = fb.content_hash
             AND rf.provider     = fb.provider
             AND rf.model        = fb.model
             AND rf.dimensions   = fb.dimensions
         )`,
      [Array.from(liveHashes)],
    )) as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }

  async deleteBlobsExcept(liveHashes: Set<string>): Promise<number> {
    const pg = await getPg();
    if (liveHashes.size === 0) {
      const rows = (await pg.unsafe(
        `DELETE FROM file_blobs fb
         WHERE NOT EXISTS (
           SELECT 1 FROM repo_files rf
           WHERE rf.content_hash = fb.content_hash
             AND rf.provider     = fb.provider
             AND rf.model        = fb.model
             AND rf.dimensions   = fb.dimensions
         )
         RETURNING content_hash`,
      )) as Array<{ content_hash: string }>;
      return rows.length;
    }
    const rows = (await pg.unsafe(
      `DELETE FROM file_blobs fb
       WHERE NOT (fb.content_hash = ANY($1::text[]))
         AND NOT EXISTS (
           SELECT 1 FROM repo_files rf
           WHERE rf.content_hash = fb.content_hash
             AND rf.provider     = fb.provider
             AND rf.model        = fb.model
             AND rf.dimensions   = fb.dimensions
         )
       RETURNING content_hash`,
      [Array.from(liveHashes)],
    )) as Array<{ content_hash: string }>;
    return rows.length;
  }

  async sweepOrphanedBlobs(opts: { dryRun: boolean }): Promise<number | null> {
    const pg = await getPg();
    const orphanWhere = `
      WHERE NOT EXISTS (
        SELECT 1 FROM repo_files rf
        WHERE rf.content_hash = fb.content_hash
          AND rf.provider     = fb.provider
          AND rf.model        = fb.model
          AND rf.dimensions   = fb.dimensions
      )
        AND NOT EXISTS (
        SELECT 1 FROM package_files pf
        WHERE pf.content_hash = fb.content_hash
      )
    `;
    if (opts.dryRun) {
      const rows = (await pg.unsafe(
        `SELECT COUNT(*)::int AS n FROM file_blobs fb ${orphanWhere}`,
      )) as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    }
    const rows = (await pg.unsafe(
      `DELETE FROM file_blobs fb ${orphanWhere} RETURNING content_hash`,
    )) as Array<{ content_hash: string }>;
    return rows.length;
  }

  async close(): Promise<void> {
    // Connection pool is shared with per-repo pg ops; closing is the caller's job.
  }
}

// ---------------------------------------------------------------------------
// pgvector literal helpers — pgvector serialises as e.g. "[0.1,0.2,0.3]"
// ---------------------------------------------------------------------------

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function parseVectorLiteral(literal: string): number[] {
  const trimmed = literal.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (trimmed.length === 0) return [];
  return trimmed.split(",").map((s) => Number(s));
}
