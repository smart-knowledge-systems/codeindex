/**
 * `codeindex dedup` subcommands. Local-only operational tooling for the
 * global dedup store: stats inspection and (in a follow-up commit) the
 * GC sweep.
 */

import { loadConfig } from "../config";
import { getGlobalStore } from "../dedup/global-store";
import type { DedupStats } from "../dedup/global-store";

interface CmdOptions {
  json?: boolean;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
