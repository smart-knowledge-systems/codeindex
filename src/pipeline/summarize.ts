import { buildDirectoryIndex } from "../index/directories";
import type { PipelineContext, SummarizeStage } from "./types";

/**
 * Build or update the directory index (concat skeletons, summaries,
 * and embeddings) for all directories containing the given files.
 *
 * The SummarizeStage type requires a summaryProvider parameter for
 * Phase 2 remote provider injection. The current implementation
 * delegates to buildDirectoryIndex which manages its own summary
 * generation, so the provider is accepted but unused until Phase 2.
 */
export const summarizeDirs: SummarizeStage = async (
  ctx: PipelineContext,
  allFiles: string[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _summaryProvider,
): Promise<void> => {
  const { repoRoot, repoId } = ctx;
  await buildDirectoryIndex(repoRoot, repoId, allFiles);
};
