import path from "path";
import { loadConfig, detectFormatter } from "../config";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { getProvider } from "../embedding-provider";
import { walkRepo, MAX_FILE_SIZE } from "../index/walker";
import { initParser } from "../index/skeleton";
import { setCurrentRepo, getProjectedCost } from "../cost";
import { setCorrelationContext, hashPath, logEvent } from "../logging";
import { ensureRepo } from "./helpers";
import { checkRepoVisibility } from "../index/public-repo";
import { ensureDedupBackend } from "../dedup/prompt";
import { getGlobalStore } from "../dedup/global-store";
import type { GlobalDedupStore } from "../dedup/global-store";
import {
  collectFiles,
  embedFiles,
  storeFiles,
  pruneStale,
  indexCommits,
  summarizeDirs,
  processDependencyPackages,
} from "../pipeline";
import type { PipelineContext, SummaryProvider } from "../pipeline";

export async function cmdReindex(repoRoot: string, dryRun = false, budget?: number, force = false) {
  const config = await loadConfig(repoRoot);
  if (budget != null) {
    config.costCap = { ...config.costCap, maxCostPerReindex: budget };
  }

  // Initialize embedding provider from config
  getProvider(config);

  const repoId = await ensureRepo(repoRoot);
  setCurrentRepo(repoId, repoRoot, config.store);
  setCorrelationContext({ repoId });

  // Check for embedding provider mismatch
  const currentProvider = config.embedding.provider ?? "openai";
  let existingProvider: string | null = null;
  if (config.store === "pg") {
    try {
      const rows = await pgUnsafe("SELECT embedding_provider FROM repos WHERE id = $1", [repoId]);
      if (rows.length > 0) existingProvider = rows[0].embedding_provider as string | null;
    } catch {
      /* column may not exist yet */
    }
  } else {
    const db = await getSqlite(repoRoot);
    try {
      const row = db.prepare("SELECT embedding_provider FROM repos WHERE id = ?").get(repoId) as {
        embedding_provider: string | null;
      } | null;
      if (row) existingProvider = row.embedding_provider;
    } catch {
      /* column may not exist yet */
    }
  }

  if (existingProvider && existingProvider !== currentProvider && !force) {
    console.error(
      `Error: Embedding provider changed from "${existingProvider}" to "${currentProvider}".`,
    );
    console.error("All existing embeddings must be regenerated. Use --force to proceed.");
    process.exit(1);
  }

  // Update repo with current embedding metadata
  if (config.store === "pg") {
    try {
      await pgUnsafe(
        "UPDATE repos SET embedding_provider = $1, embedding_dimensions = $2 WHERE id = $3",
        [currentProvider, config.embedding.dimensions, repoId],
      );
    } catch {
      /* column may not exist yet */
    }
  } else {
    const db = await getSqlite(repoRoot);
    try {
      db.prepare(
        "UPDATE repos SET embedding_provider = ?, embedding_dimensions = ? WHERE id = ?",
      ).run(currentProvider, config.embedding.dimensions, repoId);
    } catch {
      /* column may not exist yet */
    }
  }

  const formatter = config.formatter ?? (await detectFormatter(repoRoot));

  console.log(`Indexing ${repoRoot} (repo_id=${repoId}, store=${config.store})`);
  if (dryRun) console.log("(dry run — no changes will be made)");

  await initParser();

  const repoVisibility = await checkRepoVisibility(repoRoot);

  // Resolve dedup backend (prompt on first use) and open the global store.
  const dedupChoice = await ensureDedupBackend(config);
  let globalStore: GlobalDedupStore | undefined;
  if (dedupChoice.enabled && dedupChoice.backend !== null) {
    if (config.dedup) {
      config.dedup.backend = dedupChoice.backend;
      config.dedup.enabled = true;
    }
    try {
      globalStore = await getGlobalStore(config);
    } catch (err) {
      process.stderr.write(
        `[dedup] failed to open global store (${err instanceof Error ? err.message : String(err)}); proceeding without dedup\n`,
      );
    }
  }

  const ctx: PipelineContext = {
    repoRoot,
    repoId,
    config,
    formatter,
    store: config.store,
    dryRun,
    force,
    repoVisibility,
    secretOverrideCount: 0,
    globalStore,
    dedupStats: { hits: 0, misses: 0 },
  };

  // Collect files needing re-embedding
  const collected = await collectFiles(ctx);

  // Walk repo for the full file list (needed for prune/commits/summarize)
  const allFiles: string[] = [];
  for await (const relPath of walkRepo(repoRoot)) {
    const absPath = path.join(repoRoot, relPath);
    if (Bun.file(absPath).size <= MAX_FILE_SIZE) {
      allFiles.push(relPath);
    }
  }

  if (dryRun) {
    const skipped = allFiles.length - collected.length;
    console.log(`Files: ${collected.length} would be indexed, ${skipped} unchanged`);
    const overrides = ctx.secretOverrideCount ?? 0;
    if (overrides > 0) {
      console.log(
        `  (${overrides} secret-flagged files overridden — public repo, published content)`,
      );
    }
    for (const f of collected) {
      console.log(`  ${f.relPath} (${f.fileType})`);
    }
    const projected = getProjectedCost(
      collected.length,
      collected.length * 3,
      config.embedding.model,
    );
    console.log(`\nProjected cost:`);
    console.log(`  Embeddings: $${projected.embeddingCost.toFixed(4)}`);
    console.log(`  Summaries:  $${projected.summaryCost.toFixed(4)}`);
    console.log(`  Total:      $${projected.totalCost.toFixed(4)}`);
    if (config.costCap.maxCostPerReindex != null) {
      console.log(`  Budget:     $${config.costCap.maxCostPerReindex.toFixed(4)}`);
      if (projected.totalCost > config.costCap.maxCostPerReindex) {
        console.log(`  WARNING: projected cost exceeds budget`);
      }
    }
    return;
  }

  // Embed → store
  const embedded = await embedFiles(ctx, collected);
  const costExceeded = collected.length > 0 && embedded.length === 0;
  if (costExceeded) {
    return;
  }
  const indexed = embedded.length;
  const skipped = allFiles.length - indexed;

  if (embedded.length > 0) {
    await storeFiles(ctx, embedded);
  }
  console.log(`Files: ${indexed} indexed, ${skipped} skipped (unchanged)`);
  if (ctx.dedupStats && (ctx.dedupStats.hits > 0 || ctx.dedupStats.misses > 0)) {
    const { hits, misses } = ctx.dedupStats;
    const total = hits + misses;
    const pct = total > 0 ? ((hits / total) * 100).toFixed(1) : "0.0";
    const projected = getProjectedCost(hits, 0, config.embedding.model);
    console.log(
      `Dedup:  ${hits} hits / ${misses} misses (${pct}% hit rate, ~$${projected.embeddingCost.toFixed(4)} saved)`,
    );
    logEvent({
      event: "infra.dedup.summary",
      hits,
      misses,
      hit_rate: total > 0 ? hits / total : 0,
      embedding_cost_saved: projected.embeddingCost,
    });
  }

  // Index commits
  console.log("Indexing commits...");
  const commitCount = await indexCommits(ctx, allFiles);
  console.log(`Commits: ${commitCount} embedded`);

  // Prune stale entries
  const pruned = await pruneStale(ctx, new Set(allFiles));
  if (pruned > 0) console.log(`Pruned ${pruned} stale entries`);

  // Build directory index / summarize
  console.log("Building directory index...");
  const nullSummaryProvider: SummaryProvider = {
    name: "none",
    summarizeDirectory: async () => null,
  };
  await summarizeDirs(ctx, allFiles, nullSummaryProvider);
  console.log("Directory index complete.");

  // Optional: pre-warm the global dedup cache by walking installed dependency
  // packages (node_modules, vendor/...). Off by default; opt-in via
  // `dedup.indexDependencies: true` in the global config.
  if (ctx.globalStore && config.dedup?.indexDependencies) {
    console.log("Pre-warming dependency packages...");
    try {
      const depStats = await processDependencyPackages(ctx);
      const total = depStats.packageHits + depStats.packageMisses;
      if (total > 0 || depStats.packagesScanned > 0) {
        console.log(
          `Dep packages: ${depStats.packageHits} hit / ${depStats.packageMisses} miss ` +
            `(${depStats.blobsReused} blobs reused, ${depStats.blobsEmbedded} embedded)`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `[dedup] dependency walk failed (${err instanceof Error ? err.message : String(err)}); continuing\n`,
      );
    }
  }

  logEvent({
    event: "infra.reindex",
    repo_hash: hashPath(repoRoot),
    files_indexed: indexed,
    files_skipped: skipped,
  });
  console.log("Reindex complete.");
}
