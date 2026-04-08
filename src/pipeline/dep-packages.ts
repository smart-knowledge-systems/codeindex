/**
 * Dependency-package pre-warm stage.
 *
 * Phase 1 left `walkDependencies()` and the package-tier global-store schema
 * in place but never wired them into reindex. This stage closes that gap:
 *
 *   1. Walk every installed dependency package via the dep-mode walker.
 *   2. Compute each package's tree hash.
 *   3. Look the package up in the global store.
 *      - HIT: short-circuit. Just register a `repo_packages` link row so GC
 *        knows this repo references the package. No reads, no embeds.
 *      - MISS: read each indexable file, batch-look-up its blob, embed only
 *        the genuine misses, write blobs + the package row + the link row.
 *
 * The stage NEVER writes to the per-repo `files` table — dependency code
 * remains opt-in for per-repo search via `.indexignore` `!node_modules/`.
 * This stage's job is just to populate the shared global cache so that
 * (a) future reindexes of any repo with the same package short-circuit,
 * and (b) GC has the refcount data it needs.
 *
 * Gated behind `config.dedup.indexDependencies` (default off) because
 * walking `node_modules` is expensive on first run.
 */

import path from "path";
import { stat } from "fs/promises";
import { walkDependencies } from "../index/walker";
import { INDEXABLE_EXTENSIONS, MAX_FILE_SIZE } from "../index/walker";
import { extractSkeletonWithEntries } from "../index/skeleton";
import { embed } from "../index/embedder";
import { treeHash } from "../dedup/tree-hash";
import { logEvent } from "../logging";
import type { PipelineContext } from "./types";
import type { DetectedPackage } from "../dedup/package-detect";
import type { PackageFileEntry } from "../dedup/global-store";

export interface DepPackageStats {
  packagesScanned: number;
  packageHits: number;
  packageMisses: number;
  blobsReused: number;
  blobsEmbedded: number;
}

export async function processDependencyPackages(ctx: PipelineContext): Promise<DepPackageStats> {
  const stats: DepPackageStats = {
    packagesScanned: 0,
    packageHits: 0,
    packageMisses: 0,
    blobsReused: 0,
    blobsEmbedded: 0,
  };

  if (!ctx.globalStore) return stats;
  const { provider, model, dimensions } = ctx.config.embedding;
  const store = ctx.globalStore;

  for await (const pkg of walkDependencies(ctx.repoRoot)) {
    stats.packagesScanned++;
    const hash = treeHash(pkg.files);
    const mountPath = path.relative(ctx.repoRoot, pkg.rootPath);

    const existing = await store.lookupPackage({
      treeHash: hash,
      provider,
      model,
      dimensions,
    });
    if (existing) {
      await store.linkRepoPackage(ctx.repoRoot, existing.id, mountPath);
      stats.packageHits++;
      logEvent({
        event: "infra.dedup.package.hit",
        ecosystem: pkg.ecosystem,
        package_name: pkg.name,
        package_version: pkg.version,
      });
      continue;
    }

    const { reused, embedded } = await embedPackageMissedFiles(ctx, store, pkg);
    stats.blobsReused += reused;
    stats.blobsEmbedded += embedded;

    const pkgId = await store.writePackage(
      { treeHash: hash, provider, model, dimensions },
      { ecosystem: pkg.ecosystem, name: pkg.name, version: pkg.version },
      pkg.files,
    );
    await store.linkRepoPackage(ctx.repoRoot, pkgId, mountPath);
    stats.packageMisses++;
    logEvent({
      event: "infra.dedup.package.miss",
      ecosystem: pkg.ecosystem,
      package_name: pkg.name,
      package_version: pkg.version,
      blobs_reused: reused,
      blobs_embedded: embedded,
    });
  }

  if (ctx.dedupStats) {
    ctx.dedupStats.packageHits = (ctx.dedupStats.packageHits ?? 0) + stats.packageHits;
    ctx.dedupStats.packageMisses = (ctx.dedupStats.packageMisses ?? 0) + stats.packageMisses;
    ctx.dedupStats.packageBlobReuse = (ctx.dedupStats.packageBlobReuse ?? 0) + stats.blobsReused;
    ctx.dedupStats.packageBlobEmbedded =
      (ctx.dedupStats.packageBlobEmbedded ?? 0) + stats.blobsEmbedded;
  }

  return stats;
}

interface PreparedFile {
  entry: PackageFileEntry;
  skeleton: string;
  skeletonEntries: string | null;
}

async function embedPackageMissedFiles(
  ctx: PipelineContext,
  store: NonNullable<PipelineContext["globalStore"]>,
  pkg: DetectedPackage,
): Promise<{ reused: number; embedded: number }> {
  const { provider, model, dimensions } = ctx.config.embedding;

  const candidates = await filterIndexableEntries(pkg);
  if (candidates.length === 0) return { reused: 0, embedded: 0 };

  const cached = await store.lookupBlobs(
    candidates.map((c) => c.entry.contentHash),
    provider,
    model,
    dimensions,
  );

  const toEmbed: PreparedFile[] = [];
  let reused = 0;
  for (const c of candidates) {
    if (cached.has(c.entry.contentHash)) {
      reused++;
      continue;
    }
    const prepared = await readAndSkeleton(ctx, c.absPath, c.entry);
    if (prepared) toEmbed.push(prepared);
  }

  if (toEmbed.length === 0) return { reused, embedded: 0 };

  const vectors = await embed(
    toEmbed.map((t) => t.skeleton),
    ctx.config,
  );

  let embedded = 0;
  for (let i = 0; i < toEmbed.length; i++) {
    const v = vectors[i];
    if (!v || v.length === 0) continue;
    try {
      await store.writeBlob(
        { contentHash: toEmbed[i].entry.contentHash, provider, model, dimensions },
        {
          skeleton: toEmbed[i].skeleton,
          skeletonEntries: toEmbed[i].skeletonEntries,
          embedding: v,
        },
      );
      embedded++;
    } catch (err) {
      logEvent({
        event: "infra.dedup.package.write_failed",
        content_hash: toEmbed[i].entry.contentHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { reused, embedded };
}

async function filterIndexableEntries(
  pkg: DetectedPackage,
): Promise<Array<{ entry: PackageFileEntry; absPath: string }>> {
  const out: Array<{ entry: PackageFileEntry; absPath: string }> = [];
  for (const entry of pkg.files) {
    const ext = path.extname(entry.relpath).toLowerCase();
    if (!ext || !INDEXABLE_EXTENSIONS.has(ext)) continue;
    const absPath = path.join(pkg.rootPath, entry.relpath);
    try {
      const s = await stat(absPath);
      if (s.size > MAX_FILE_SIZE) continue;
    } catch {
      continue;
    }
    out.push({ entry, absPath });
  }
  return out;
}

async function readAndSkeleton(
  ctx: PipelineContext,
  absPath: string,
  entry: PackageFileEntry,
): Promise<PreparedFile | null> {
  let raw: string;
  try {
    raw = await Bun.file(absPath).text();
  } catch {
    return null;
  }
  const content = raw.replace(/\0/g, "");
  const { text: skeleton, entries } = await extractSkeletonWithEntries(
    entry.relpath,
    content,
    ctx.config.skeletonFallbackLines,
  );
  return {
    entry,
    skeleton,
    skeletonEntries: entries.length > 0 ? JSON.stringify(entries) : null,
  };
}
