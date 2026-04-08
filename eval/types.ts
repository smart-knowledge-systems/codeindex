import type { ScoringConfig } from "../src/search/types";

export interface EvalQuery {
  id: string;
  query: string;
  expectedFiles: string[];
  expectedTypes?: string[];
  description?: string;
  tags?: string[];
  repo?: string;
  language?: string;
  addedAt?: string; // ISO date when query was added
  lastValidated?: string; // ISO date when last validated
}

export interface SummaryAssessment {
  dirPath: string;
  accuracy: number;
  completeness: number;
  navigability: number;
  notes?: string;
}

export interface EvalResult {
  queryId: string;
  query: string;
  precision5: number;
  hitRate5: number;
  recall: number;
  mrr: number;
  ndcg: number;
  returnedFiles: string[];
  expectedFiles: string[];
  scoringConfig: Partial<ScoringConfig>;
  uniqueFilesInTop5?: number;
  uniqueDirsInTop5?: number;
}

/**
 * Snapshot of the global dedup store at the time the eval ran. Captured so a
 * regression in dedup behavior (cache silently disabled, accidental wipe,
 * dedup_savings drop after a refactor) shows up as a sudden delta in the
 * eval baseline rather than a hidden cost regression on the next reindex.
 */
export interface DedupSnapshot {
  enabled: boolean;
  backend?: string;
  blobCount?: number;
  packageCount?: number;
  repoLinkCount?: number;
  storageBytes?: number | null;
}

export interface EvalSummary {
  configName: string;
  model?: string;
  avgPrecision5: number;
  avgHitRate5: number;
  avgRecall: number;
  avgMrr: number;
  avgNdcg: number;
  costPer1kFiles?: number;
  avgUniqueFilesInTop5?: number;
  avgUniqueDirsInTop5?: number;
  results: EvalResult[];
  timestamp: string;
  dedup?: DedupSnapshot;
}
