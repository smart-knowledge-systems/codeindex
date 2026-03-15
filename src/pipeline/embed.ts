import { embed } from "../index/embedder";
import { checkCostCap } from "../cost";
import type { PipelineContext, CollectedFile, EmbeddedFile, EmbedStage } from "./types";

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

  process.stderr.write(`Indexing: 0/${files.length} files...`);
  const embeddings = await embed(
    files.map((f) => f.skeleton),
    config,
  );
  process.stderr.write(`\rIndexing: ${files.length}/${files.length} files...\n`);

  // Check cost cap after embedding batch
  if (config.costCap.maxCostPerReindex != null) {
    const cap = await checkCostCap(repoRoot, repoId);
    if (cap.current >= (config.costCap.warnAt ?? Infinity)) {
      console.warn(
        `Cost warning: $${cap.current.toFixed(4)} spent (limit: $${cap.limit?.toFixed(4)})`,
      );
    }
    if (cap.exceeded) {
      console.error(
        `Cost cap exceeded: $${cap.current.toFixed(4)} >= $${cap.limit?.toFixed(4)}. Aborting.`,
      );
      // Return empty to signal caller that cost cap was exceeded
      return [];
    }
  }

  return files.map((f, i) => ({ ...f, embedding: embeddings[i] }));
};
