import type { EvalSummary } from "../../eval/types";

export interface QualityPolicy {
  name: string;
  description: string;
  assert(summary: EvalSummary): QualityResult;
}

export interface QualityResult {
  passed: boolean;
  metric: string;
  actual: number;
  threshold: number;
  message: string;
}

export interface QualityConfig {
  dataset: string;
  baseline?: string;
  policies: Array<{
    name: string;
    threshold: number;
  }>;
}
