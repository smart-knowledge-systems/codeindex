/**
 * `codeindex dedup` subcommands. Local-only operational tooling for the
 * global dedup store: stats inspection and (in a follow-up commit) the
 * GC sweep.
 */

import { loadConfig } from "../config";
import { getGlobalStore } from "../dedup/global-store";
import { repoGetAll, getStoreOps } from "../repo";
import type { DedupStats } from "../dedup/global-store";

interface CmdOptions {
  json?: boolean;
  dryRun?: boolean;
}

/**
 * `codeindex dedup stats [--json]` — print L1 global-store contents:
 * blob count, package count, repo→package link count, per-ecosystem and
 * per-provider breakdowns, and on-disk size for SQLite backends.
 */
export async function cmdDedupStats(repoRoot: string, opts: CmdOptions = {}): Promise<void> {
  const config = await loadConfig(repoRoot);
  if (!config.dedup?.enabled || !config.dedup.backend) {
    if (opts.json) {
      console.log(JSON.stringify({ enabled: false }));
    } else {
      console.log("Dedup is disabled. Enable it via `codeindex reindex` (first-use prompt).");
    }
    return;
  }

  const store = await getGlobalStore(config);
  const stats = await store.stats();

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          enabled: true,
          backend: config.dedup.backend,
          ...stats,
        },
        null,
        2,
      ),
    );
    return;
  }

  printStatsHuman(stats, config.dedup.backend);
}

function printStatsHuman(stats: DedupStats, backend: string): void {
  console.log(`Dedup global store (${backend})`);
  console.log("─".repeat(60));
  console.log(`  Content blobs:     ${stats.blobCount.toLocaleString()}`);
  console.log(`  Packages:          ${stats.packageCount.toLocaleString()}`);
  console.log(`  Repo→pkg links:    ${stats.repoLinkCount.toLocaleString()}`);
  if (stats.storageBytes != null) {
    console.log(`  On-disk size:      ${formatBytes(stats.storageBytes)}`);
  }

  if (stats.ecosystems.length > 0) {
    console.log("\nPackages by ecosystem:");
    for (const e of stats.ecosystems) {
      console.log(`  ${e.ecosystem.padEnd(10)} ${e.count}`);
    }
  }

  if (stats.providers.length > 0) {
    console.log("\nBlobs by provider/model:");
    for (const p of stats.providers) {
      console.log(`  ${p.provider}/${p.model} (${p.dimensions}d)  ${p.blobs}`);
    }
  }
}

/**
 * `codeindex dedup gc [--dry-run] [--json]` — sweep unreferenced blobs and
 * orphaned packages from the global store.
 *
 * The package tier is GC'd by removing rows whose `repo_packages` link count
 * dropped to zero. The blob tier is GC'd by computing the live set as the
 * union of:
 *   1. content_hashes referenced by package_files of surviving packages
 *   2. content_hashes referenced by every registered repo's `files` table
 * and deleting any blob whose hash is not in that set. Blob entries written
 * outside any package context (the regular collect path) are kept exactly
 * when at least one registered repo still has a `files` row pointing at them.
 */
export async function cmdDedupGc(repoRoot: string, opts: CmdOptions = {}): Promise<void> {
  const config = await loadConfig(repoRoot);
  if (!config.dedup?.enabled || !config.dedup.backend) {
    if (opts.json) console.log(JSON.stringify({ enabled: false }));
    else console.log("Dedup is disabled — nothing to GC.");
    return;
  }

  const store = await getGlobalStore(config);

  const orphanIds = await store.listOrphanedPackageIds();
  const liveFromPackages = await store.listLivePackageBlobHashes(orphanIds);
  const liveFromRepos = await collectLiveBlobHashesFromRepos(repoRoot);

  const liveHashes = new Set<string>([...liveFromPackages, ...liveFromRepos]);
  const blobsToDelete = await store.countBlobsExcept(liveHashes);

  const plan = {
    enabled: true,
    dryRun: opts.dryRun ?? false,
    orphanedPackages: orphanIds.length,
    liveHashes: liveHashes.size,
    liveFromPackages: liveFromPackages.length,
    liveFromRepos: liveFromRepos.length,
    blobsToDelete,
  };

  if (opts.dryRun) {
    if (opts.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      printGcPlan(plan, "Would delete");
    }
    return;
  }

  await store.deletePackages(orphanIds);
  const blobsDeleted = await store.deleteBlobsExcept(liveHashes);

  const result = { ...plan, dryRun: false, blobsDeleted };
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printGcPlan({ ...plan, blobsToDelete: blobsDeleted }, "Deleted");
  }
}

interface GcPlan {
  orphanedPackages: number;
  liveHashes: number;
  liveFromPackages: number;
  liveFromRepos: number;
  blobsToDelete: number;
}

function printGcPlan(plan: GcPlan, verb: string): void {
  console.log(`${verb}:`);
  console.log(`  ${plan.orphanedPackages} orphaned package(s)`);
  console.log(`  ${plan.blobsToDelete} unreferenced blob(s)`);
  console.log("");
  console.log(`Live hash set: ${plan.liveHashes.toLocaleString()} unique`);
  console.log(`  ${plan.liveFromPackages} from surviving package_files`);
  console.log(`  ${plan.liveFromRepos} from registered repo files tables`);
}

async function collectLiveBlobHashesFromRepos(repoRoot: string): Promise<string[]> {
  const live = new Set<string>();
  const repos = await repoGetAll(repoRoot);
  for (const repo of repos) {
    try {
      const { ops } = await getStoreOps(repo.root_path);
      const rows = await ops.query<{ content_hash: string }>(
        `SELECT DISTINCT content_hash FROM files WHERE content_hash IS NOT NULL`,
      );
      for (const r of rows) live.add(r.content_hash);
    } catch (err) {
      process.stderr.write(
        `[dedup-gc] failed to read repo "${repo.name}" at ${repo.root_path} (${
          err instanceof Error ? err.message : String(err)
        }); skipping — its blobs will not be retained\n`,
      );
    }
  }
  return Array.from(live);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
