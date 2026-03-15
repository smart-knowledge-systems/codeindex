import { embed } from "../index/embedder";
import { logEvent } from "../logging";
import { checkCostCap } from "../cost";
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
    logEvent({
      event: "infra.cost.warning",
      current_cost: cap.current,
      limit: cap.limit,
    });
  }

  if (cap.exceeded) {
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
 * Checks the cost cap after embedding and sets costExceeded on the result.
 * Returns EmbeddedFile[] — one per input CollectedFile.
 */
export const embedFiles: EmbedStage = async (
  ctx: PipelineContext,
  files: CollectedFile[],
): Promise<EmbeddedFile[]> => {
  if (files.length === 0) return [];

  const { repoRoot, repoId, config } = ctx;
  const start = performance.now();

  logEvent({ event: "infra.embed.start", file_count: files.length });

  const embeddings = await embed(
    files.map((f) => f.skeleton),
    config,
  );

  logEvent({
    event: "infra.embed.complete",
    file_count: files.length,
    duration_ms: Math.round(performance.now() - start),
  });

  const exceeded = await checkAndLogCostCap(repoRoot, repoId, config);
  if (exceeded) return [];

  return files.map((f, i) => ({ ...f, embedding: embeddings[i] }));
};
