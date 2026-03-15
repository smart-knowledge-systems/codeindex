import type { CodeindexConfig } from "../search/types";
import type { ImportEdge } from "../index/imports";

// ---------------------------------------------------------------------------
// Intermediate representations
// ---------------------------------------------------------------------------

/**
 * Output of the collect stage: one file that needs re-embedding.
 * Carries all data needed by downstream stages so nothing re-reads disk.
 */
export interface CollectedFile {
  relPath: string; // repo-relative path, e.g. "src/foo.ts"
  absPath: string; // absolute path on disk
  fileType: string; // lowercased extension, e.g. ".ts"
  contentHash: string; // formatter-derived content hash
  content: string; // raw file content (NUL-stripped)
  skeleton: string; // extracted skeleton text used for embedding
  skeletonEntries: string | null; // JSON-serialized SkeletonEntry[] or null
  importEdges: ImportEdge[]; // raw import edges extracted from content
}

/**
 * Output of the embed stage: CollectedFile with its embedding vector attached.
 */
export interface EmbeddedFile extends CollectedFile {
  embedding: number[];
}

// ---------------------------------------------------------------------------
// Pipeline context
// ---------------------------------------------------------------------------

/**
 * Shared immutable context passed to every pipeline stage.
 * Created once by the orchestrator (cmdReindex / cmdUpdate) and threaded through.
 */
export interface PipelineContext {
  repoRoot: string;
  repoId: number;
  config: CodeindexConfig;
  formatter: string | null; // resolved: config.formatter ?? detectFormatter()
  store: "pg" | "sqlite"; // convenience alias for config.store
  dryRun: boolean; // when true, collect runs but embed/store are skipped
  force: boolean; // when true, collect bypasses content-hash dedup
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

/** Non-fatal error for a single file during the pipeline run. */
export interface PipelineError {
  relPath: string;
  reason: string;
}

/** Overall outcome returned by a full pipeline run. */
export interface PipelineResult {
  indexed: number;
  skipped: number;
  pruned: number;
  commitCount: number;
  costExceeded: boolean;
  errors: PipelineError[];
}

// ---------------------------------------------------------------------------
// Summary provider
// ---------------------------------------------------------------------------

/**
 * Abstraction for directory summary generation.
 * Implementations can use the local Anthropic SDK, the Claude CLI, or a
 * remote model endpoint (Phase 2). Stages depend only on this interface.
 */
export interface SummaryProvider {
  readonly name: string;
  /**
   * Generate a 1-3 sentence summary of a directory.
   * Returns null when summarization is unavailable or fails gracefully.
   */
  summarizeDirectory(concatSkeleton: string, childSummaries: string[]): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Stage function signatures
// ---------------------------------------------------------------------------

/**
 * Walk the repo, load existing content hashes from DB internally,
 * and return files that need re-embedding.
 */
export type CollectStage = (ctx: PipelineContext) => Promise<CollectedFile[]>;

/**
 * Batch-embed the skeletons of all collected files.
 */
export type EmbedStage = (ctx: PipelineContext, files: CollectedFile[]) => Promise<EmbeddedFile[]>;

/**
 * Upsert embedded files into the DB, build the FileIndex internally,
 * and refresh import edges for all stored files.
 */
export type StoreFilesStage = (ctx: PipelineContext, files: EmbeddedFile[]) => Promise<void>;

/**
 * Remove DB rows for files that are no longer present in the repo.
 * Returns the count of pruned rows.
 */
export type PruneStage = (ctx: PipelineContext, currentFiles: Set<string>) => Promise<number>;

/**
 * Walk git log, embed commit messages, and upsert commit records
 * and file_commits links into the DB.
 * Returns the count of newly embedded commits.
 */
export type IndexCommitsStage = (ctx: PipelineContext, allFiles: string[]) => Promise<number>;

/**
 * Build or update the directory index (concat skeletons, summaries,
 * and embeddings) for all directories containing the given files.
 */
export type SummarizeStage = (
  ctx: PipelineContext,
  allFiles: string[],
  summaryProvider: SummaryProvider,
) => Promise<void>;
