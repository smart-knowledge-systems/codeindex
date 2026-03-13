export interface SearchResult {
  filePath: string;
  cosineSimilarity: number;
  finalScore: number;
  type: string;
  inProject: boolean;
  repoId?: string;
  commitIds?: string[];
  skeleton?: string;
  summary?: string;
}

export interface SearchOptions {
  minScore?: number;
  topN?: number;
  scope?: "project" | "all" | string[];
  includeSkeleton?: boolean;
  includeSummary?: boolean;
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
  };
  scoring: ScoringConfig;
  formatter: string | null;
  skeletonFallbackLines: number;
}

export interface ScoringConfig {
  commitDecay: number;
  commitDepth: number;
  alpha: number;
  beta: number;
  minScore: number;
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
