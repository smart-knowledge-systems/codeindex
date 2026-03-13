import type { ScoringConfig } from "../src/search/types";

export interface EvalQuery {
  id: string;
  query: string;
  expectedFiles: string[];
  expectedTypes?: string[];
  description?: string;
  tags?: string[];
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
  recall: number;
  mrr: number;
  returnedFiles: string[];
  expectedFiles: string[];
  scoringConfig: Partial<ScoringConfig>;
}

export interface EvalSummary {
  configName: string;
  avgPrecision5: number;
  avgRecall: number;
  avgMrr: number;
  results: EvalResult[];
  timestamp: string;
}
