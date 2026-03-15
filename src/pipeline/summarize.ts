import { buildDirectoryIndex } from "../index/directories";
import type { PipelineContext, SummarizeStage, SummaryProvider } from "./types";

/**
 * Build or update the directory index (concat skeletons, summaries,
 * and embeddings) for all directories containing the given files.
 *
 * The summaryProvider is passed through for future use (Phase 2 remote
 * provider injection), but the current implementation delegates to the
 * existing buildDirectoryIndex which manages its own summary generation.
 */
export const summarizeDirs: SummarizeStage = async (
  ctx: PipelineContext,
  allFiles: string[],
  // summaryProvider reserved for Phase 2 remote injection
  _summaryProvider: SummaryProvider, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<void> => {
  const { repoRoot, repoId } = ctx;
  await buildDirectoryIndex(repoRoot, repoId, allFiles);
};
