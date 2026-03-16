// ---------------------------------------------------------------------------
// Internal row shapes returned by DB queries
// ---------------------------------------------------------------------------

export interface PgFileRow {
  id: string;
  repo_id: string;
  file_path: string;
  skeleton: string | null;
  file_type: string;
  similarity: string;
}

export interface PgDirRow {
  id: string;
  repo_id: string;
  dir_path: string;
  summary: string | null;
  concat_sim: string;
  summary_sim: string;
}

export interface PgCommitRow {
  id: string;
  repo_id: string;
  commit_hash: string;
  message: string;
  similarity: string;
}

export interface PgFileLinkRow {
  file_id: string;
  commit_id: string;
  recency: string;
  similarity: string;
}

export interface PgRepoRow {
  id: string;
  root_path: string;
  name: string;
}

export interface SqliteFileRow {
  id: number;
  repo_id: number;
  file_path: string;
  skeleton: string | null;
  file_type: string;
  distance: number;
}

export interface SqliteDirRow {
  id: number;
  repo_id: number;
  dir_path: string;
  summary: string | null;
  concat_distance: number | null;
  summary_distance: number | null;
}

export interface SqliteCommitRow {
  id: number;
  repo_id: number;
  commit_hash: string;
  message: string;
  distance: number;
}

export interface SqliteFileLinkRow {
  file_id: number;
  commit_id: number;
  recency: number;
  distance: number;
}

export interface SqliteRepoRow {
  id: number;
  root_path: string;
  name: string;
}
