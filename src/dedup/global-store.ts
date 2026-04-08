/**
 * GlobalDedupStore — file- and package-level embedding cache shared across
 * all repos on this machine. Source-of-truth for cached embeddings; per-repo
 * DBs still hold their own copies for search, populated from this store on
 * dedup hits.
 *
 * Two backends sit behind this interface:
 *   - SQLite: ~/.codeindex/global.db (default, zero-config local-first)
 *   - Postgres: same instance as the per-repo store, separate tables
 *
 * The dedup key for blobs is (content_hash, provider, model, dimensions) so
 * different embedding configs never collide.
 */

import type { CodeindexConfig } from "../search/types";

export interface BlobKey {
  contentHash: string;
  provider: string;
  model: string;
  dimensions: number;
}

export interface BlobRecord {
  skeleton: string | null;
  skeletonEntries: string | null;
  embedding: number[];
}

export interface PackageKey {
  treeHash: string;
  provider: string;
  model: string;
  dimensions: number;
}

export interface PackageRecord {
  id: number;
  ecosystem: string;
  name: string;
  version: string;
}

export interface PackageFileEntry {
  relpath: string;
  contentHash: string;
}

export interface PackageMeta {
  ecosystem: string;
  name: string;
  version: string;
}

export interface DedupStats {
  blobCount: number;
  packageCount: number;
  /** Number of repo→package link rows (the GC refcount source). */
  repoLinkCount: number;
  /** Per-ecosystem package counts. */
  ecosystems: Array<{ ecosystem: string; count: number }>;
  /** Per-(provider, model, dimensions) blob counts. */
  providers: Array<{ provider: string; model: string; dimensions: number; blobs: number }>;
  /** On-disk byte count for the SQLite store (null on Postgres). */
  storageBytes: number | null;
}

export interface GlobalDedupStore {
  /** Look up a single blob by content hash. Returns null on miss. */
  lookupBlob(key: BlobKey): Promise<BlobRecord | null>;

  /**
   * Batch lookup. `hashes` are the content hashes to query; provider/model/dims
   * are taken from the embedding config. Returns a map keyed by content hash —
   * absent entries are misses.
   */
  lookupBlobs(
    hashes: string[],
    provider: string,
    model: string,
    dimensions: number,
  ): Promise<Map<string, BlobRecord>>;

  /** Insert (or no-op if exists) a blob and increment its refcount. */
  writeBlob(key: BlobKey, record: BlobRecord): Promise<void>;

  /** Look up a package by tree hash. Returns null on miss. */
  lookupPackage(key: PackageKey): Promise<PackageRecord | null>;

  /** List file entries for a known package. */
  listPackageFiles(packageId: number): Promise<PackageFileEntry[]>;

  /**
   * Insert a package row + its file entries. Returns the package id.
   * Caller is responsible for having already written the underlying blobs
   * via writeBlob().
   */
  writePackage(key: PackageKey, meta: PackageMeta, files: PackageFileEntry[]): Promise<number>;

  /** Link a repo to a package it consumes (for future GC refcounting). */
  linkRepoPackage(repoRoot: string, packageId: number, mountPath: string): Promise<void>;

  /** Diagnostic counts for telemetry. */
  stats(): Promise<DedupStats>;

  /** Close any underlying connection (idempotent). */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let _instance: GlobalDedupStore | null = null;

/**
 * @impure Returns the configured global dedup store, opening it on first call.
 * Backend choice comes from config.dedup.backend (added in commit 4); until
 * that lands the factory defaults to SQLite at ~/.codeindex/global.db.
 */
export async function getGlobalStore(config: CodeindexConfig): Promise<GlobalDedupStore> {
  if (_instance) return _instance;

  const backend = (config as CodeindexConfig & { dedup?: { backend?: string } }).dedup?.backend;
  if (backend === "pg") {
    const { openPgGlobalStore } = await import("./global-store-pg");
    _instance = await openPgGlobalStore(config);
  } else {
    const { openSqliteGlobalStore } = await import("./global-store-sqlite");
    _instance = await openSqliteGlobalStore(config);
  }
  return _instance;
}

/** @impure Reset the cached factory instance — used by tests. */
export async function resetGlobalStore(): Promise<void> {
  if (_instance) {
    await _instance.close();
    _instance = null;
  }
}
