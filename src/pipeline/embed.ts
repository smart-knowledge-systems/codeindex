import { embed } from "@easier-idx/embedding";
import { logEvent } from "../logging";
import { checkCostCap } from "../cost";
import { getProvider } from "../embedding-provider";
import type { PipelineContext, CollectedFile, EmbeddedFile, EmbedStage } from "./types";

/**
 * Check whether the cost cap has been exceeded after an embedding batch.
 * Returns true if the cap was exceeded and processing should stop.
 */
async function checkAndLogCostCap(
  repoRoot: string,
  repoId: number,
  config: PipelineContext["config"],
): Promise<boolean> {
  if (config.costCap.maxCostPerReindex == null) return false;

  const cap = await checkCostCap(repoRoot, repoId);

  if (cap.current >= (config.costCap.warnAt ?? Infinity)) {
    process.stderr.write(
      `Warning: embedding cost $${cap.current.toFixed(4)} approaching cap $${cap.limit?.toFixed(4)}\n`,
    );
    logEvent({
      event: "infra.cost.warning",
      current_cost: cap.current,
      limit: cap.limit,
    });
  }

  if (cap.exceeded) {
    process.stderr.write(
      `Cost cap exceeded: $${cap.current.toFixed(4)} >= $${cap.limit?.toFixed(4)}. Aborting embedding.\n`,
    );
    logEvent({
      event: "infra.cost.exceeded",
      current_cost: cap.current,
      limit: cap.limit,
    });
    return true;
  }

  return false;
}

/**
 * Batch-embed the skeletons of all collected files.
 * Partitions dedup-cache hits from misses so cached files skip the embedder entirely.
 * Checks the cost cap after embedding and sets costExceeded on the result.
 * Returns EmbeddedFile[] — one per input CollectedFile (failed embeds are dropped).
 */
export const embedFiles: EmbedStage = async (
  ctx: PipelineContext,
  files: CollectedFile[],
): Promise<EmbeddedFile[]> => {
  if (files.length === 0) return [];

  const { repoRoot, repoId, config } = ctx;

  // Partition: files with a cached embedding (dedup hits) skip the embedder
  // entirely; only the rest go through the API.
  const cached: EmbeddedFile[] = [];
  const needEmbed: { idx: number; file: CollectedFile }[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.cachedEmbedding && f.cachedEmbedding.length > 0) {
      cached.push({ ...f, embedding: f.cachedEmbedding });
    } else {
      needEmbed.push({ idx: i, file: f });
    }
  }

  const start = performance.now();
  logEvent({
    event: "infra.embed.start",
    file_count: needEmbed.length,
    cached_count: cached.length,
  });

  const freshlyEmbedded: EmbeddedFile[] = [];
  let skipped = 0;
  if (needEmbed.length > 0) {
    const embeddings = await embed(
      getProvider(config),
      needEmbed.map((e) => e.file.skeleton),
    );

    logEvent({
      event: "infra.embed.complete",
      file_count: needEmbed.length,
      duration_ms: Math.round(performance.now() - start),
    });

    const exceeded = await checkAndLogCostCap(repoRoot, repoId, config);
    if (exceeded) return [];

    for (let i = 0; i < needEmbed.length; i++) {
      if (embeddings[i].length > 0) {
        freshlyEmbedded.push({ ...needEmbed[i].file, embedding: embeddings[i] });
      } else {
        skipped++;
      }
    }
  } else {
    logEvent({
      event: "infra.embed.complete",
      file_count: 0,
      cached_count: cached.length,
      duration_ms: Math.round(performance.now() - start),
    });
  }

  if (skipped > 0) {
    process.stderr.write(`  ${skipped} file(s) skipped due to embedding failures\n`);
    logEvent({ event: "infra.embed.skipped_files", count: skipped });
  }

  // Preserve original input order so downstream stages see deterministic ordering.
  const merged: EmbeddedFile[] = [];
  let cachedIdx = 0;
  let freshIdx = 0;
  for (const f of files) {
    if (f.cachedEmbedding && f.cachedEmbedding.length > 0) {
      merged.push(cached[cachedIdx++]);
    } else if (
      freshIdx < freshlyEmbedded.length &&
      freshlyEmbedded[freshIdx].relPath === f.relPath
    ) {
      merged.push(freshlyEmbedded[freshIdx++]);
    }
    // else: dropped due to embedding failure; intentionally omitted.
  }
  return merged;
};
