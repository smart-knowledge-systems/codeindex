export interface ScoreExplanation {
  cosineSimilarity: number;
  commitBoost: number;
  parentBoost: number;
  childBoost?: number;
  keywordScore?: number;
  lengthPenalty?: number;
  weights: { alpha: number; beta: number; gamma: number };
  formula: string;
}

export interface SearchResult {
  filePath: string;
  cosineSimilarity: number;
  finalScore: number;
  type: string;
  inProject: boolean;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  commitIds?: string[];
  skeleton?: string;
  summary?: string;
  keywordScore?: number;
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
  explanation?: ScoreExplanation;
  crossRepoEdges?: Array<{
    repoName: string;
    direction: "depends-on" | "depended-by";
  }>;
  cluster?: string;
  clusterLabel?: string;
}

export interface EmbeddingCacheLike {
  get(text: string): number[] | undefined;
  set(text: string, embedding: number[]): void;
}

export interface SearchOptions {
  minScore?: number;
  topN?: number;
  scope?: "project" | "all" | string[];
  includeSkeleton?: boolean;
  includeSummary?: boolean;
  includeSnippet?: boolean;
  scoringOverrides?: Partial<ScoringConfig>;
  lang?: string[];
  dir?: string[];
  since?: string;
  explain?: boolean;
  embeddingCache?: EmbeddingCacheLike;
}

export interface SkeletonEntry {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface RerankingConfig {
  enabled: boolean;
  importProximityWeight: number;
  crossRepoWeight: number;
  coChangeWeight: number;
}

export interface CodeindexConfig {
  store: "pg" | "sqlite";
  pg: {
    host: string;
    port: number;
    database: string;
    user: string;
  };
  sqlite: {
    path: string;
  };
  embedding: {
    model: string;
    dimensions: number;
    provider: "openai" | "ollama" | "remote";
    ollamaUrl?: string;
    remoteUrl?: string;
    remoteAuth?: string;
  };
  scoring: ScoringConfig;
  formatter: string | null;
  skeletonFallbackLines: number;
  costCap: {
    maxCostPerReindex: number | null;
    warnAt: number | null;
  };
  readOnly?: boolean;
  languageProfiles?: Record<string, Partial<ScoringConfig>>;
  reranking?: RerankingConfig;
  providerProfiles?: Record<string, Partial<ScoringConfig>>;
  dedup?: DedupConfig;
  search?: SearchConfig;
}

export interface SearchConfig {
  /**
   * When true, the PG/SQLite search backends use the content-addressed
   * `file_blobs` + `repo_files` junction schema instead of the legacy
   * per-repo `files` table. Default false during the dual-write transition;
   * flipped to true once all consumers (xref, gc, export) have migrated.
   */
  useBlobSchema?: boolean;
}

export interface DedupConfig {
  /** Master switch. When false, dedup is bypassed entirely. */
  enabled: boolean;
  /**
   * Where the global dedup store lives. `null` means the user has not yet
   * been prompted; the next reindex will trigger an interactive chooser.
   */
  backend: "pg" | "sqlite" | null;
  /** Override path for the SQLite global store (default: ~/.codeindex/global.db). */
  sqlitePath?: string;
  /**
   * Pre-warm the global store by walking installed dependency packages
   * (`node_modules`, `vendor/`) in each reindex. Off by default — turning this
   * on will embed dep-package code on first encounter, then deduplicate every
   * subsequent reindex (local or cross-repo) at near-zero cost.
   */
  indexDependencies?: boolean;
}

export interface ScoringConfig {
  commitDecay: number;
  commitDepth: number;
  alpha: number;
  beta: number;
  gamma: number;
  minScore: number;
  parentBoostMultiplier: number;
  hybridWeight: number;
  lengthPenaltyWeight: number;
}

export interface RepoRecord {
  id: number;
  origin_url: string | null;
  root_path: string;
  name: string;
  formatter_cmd: string | null;
}

export interface FileRecord {
  id: number;
  repo_id: number;
  file_path: string;
  content_hash: string;
  skeleton: string | null;
  file_type: string;
  embedding: number[] | null;
  indexed_at: string;
}

export interface DirectoryRecord {
  id: number;
  repo_id: number;
  dir_path: string;
  concat_skeleton: string | null;
  concat_embedding: number[] | null;
  summary: string | null;
  summary_embedding: number[] | null;
}

export interface CommitRecord {
  id: number;
  repo_id: number;
  commit_hash: string;
  message: string;
  embedding: number[] | null;
  authored_at: string | null;
}

export interface FileCommitLink {
  file_id: number;
  commit_id: number;
  recency: number;
}
