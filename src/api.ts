/**
 * Typed agent API surface for codeindex.
 *
 * Import from "codeindex/api" (or directly from this module) to get
 * programmatic access to search, database, config, and cost utilities.
 */

export { search, searchFiles, searchDirectories, searchCommits } from "./search/query";
export type {
  SearchOptions,
  SearchResult,
  ScoringConfig,
  ScoreExplanation,
  CodeindexConfig,
  SkeletonEntry,
} from "./search/types";
export { pgUnsafe } from "./db/pg";
export { getSqlite } from "./db/sqlite";
export { loadConfig } from "./config";
export { getCostSummary } from "./cost";
export { extractImports, resolveImport } from "./index/imports";
export type { ImportEdge } from "./index/imports";
export { discoverCrossRepoEdges } from "./index/cross-repo";
export type { CrossRepoEdge } from "./index/cross-repo";
