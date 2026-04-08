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
 * dropped to zero. The blob tier on PG is a single NOT EXISTS sweep: any
 * `file_blobs` row not referenced by `repo_files` (per-repo) and not pinned
 * by `package_files` (global package cache) is collected.
 *
 * On SQLite the global store still uses its own `content_blobs` table, so
 * `sweepOrphanedBlobs()` returns null and we fall back to the legacy live-set
 * protocol — union of (a) hashes from surviving package_files and (b) hashes
 * from every registered repo's `files` table — until the SQLite machine-wide
 * dedup unification follow-up lands.
 */
export async function cmdDedupGc(repoRoot: string, opts: CmdOptions = {}): Promise<void> {
  const config = await loadConfig(repoRoot);
  if (!config.dedup?.enabled || !config.dedup.backend) {
    if (opts.json) console.log(JSON.stringify({ enabled: false }));
    else console.log("Dedup is disabled — nothing to GC.");
    return;
  }

  const store = await getGlobalStore(config);
  const dryRun = opts.dryRun ?? false;

  // Package tier (unchanged): orphan packages whose repo_packages link
  // count dropped to zero.
  const orphanIds = await store.listOrphanedPackageIds();

  // Try the unified single-pass sweep first. PG returns a number; SQLite
  // returns null and we fall back to the legacy live-set computation.
  const sweptCandidates = await store.sweepOrphanedBlobs({ dryRun: true });

  if (sweptCandidates !== null) {
    const plan = {
      enabled: true,
      dryRun,
      orphanedPackages: orphanIds.length,
      blobsToDelete: sweptCandidates,
      strategy: "not-exists-sweep" as const,
    };

    if (dryRun) {
      if (opts.json) console.log(JSON.stringify(plan, null, 2));
      else printGcPlan(plan, "Would delete");
      return;
    }

    await store.deletePackages(orphanIds);
    const blobsDeleted = (await store.sweepOrphanedBlobs({ dryRun: false })) ?? 0;

    const result = { ...plan, dryRun: false, blobsDeleted };
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printGcPlan({ ...plan, blobsToDelete: blobsDeleted }, "Deleted");
    return;
  }

  // Legacy live-set path (SQLite global store).
  const liveFromPackages = await store.listLivePackageBlobHashes(orphanIds);
  const liveFromRepos = await collectLiveBlobHashesFromRepos(repoRoot);

  const liveHashes = new Set<string>([...liveFromPackages, ...liveFromRepos]);
  const blobsToDelete = await store.countBlobsExcept(liveHashes);

  const plan = {
    enabled: true,
    dryRun,
    orphanedPackages: orphanIds.length,
    liveHashes: liveHashes.size,
    liveFromPackages: liveFromPackages.length,
    liveFromRepos: liveFromRepos.length,
    blobsToDelete,
    strategy: "live-set" as const,
  };

  if (dryRun) {
    if (opts.json) console.log(JSON.stringify(plan, null, 2));
    else printLegacyGcPlan(plan, "Would delete");
    return;
  }

  await store.deletePackages(orphanIds);
  const blobsDeleted = await store.deleteBlobsExcept(liveHashes);

  const result = { ...plan, dryRun: false, blobsDeleted };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printLegacyGcPlan({ ...plan, blobsToDelete: blobsDeleted }, "Deleted");
}

interface GcPlan {
  orphanedPackages: number;
  blobsToDelete: number;
}

interface LegacyGcPlan extends GcPlan {
  liveHashes: number;
  liveFromPackages: number;
  liveFromRepos: number;
}

function printGcPlan(plan: GcPlan, verb: string): void {
  console.log(`${verb}:`);
  console.log(`  ${plan.orphanedPackages} orphaned package(s)`);
  console.log(`  ${plan.blobsToDelete} unreferenced blob(s)`);
}

function printLegacyGcPlan(plan: LegacyGcPlan, verb: string): void {
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
