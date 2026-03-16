import fs from "fs";
import path from "path";
import { runEval } from "../../eval/run-eval";
import type { EvalQuery, EvalResult, EvalSummary } from "../../eval/types";
import type { QualityPolicy, QualityResult } from "./quality-types";
import { precisionAt5 } from "./quality-policies/precision-at-5";
import { mrrThreshold } from "./quality-policies/mrr-threshold";
import { noRegression } from "./quality-policies/no-regression";

export interface QualityReport {
  passed: boolean;
  datasetPath: string;
  queryCount: number;
  results: Array<{ policy: string; result: QualityResult }>;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/** Compute aggregate metrics from individual eval results. */
function computeSummary(evalResults: EvalResult[]): EvalSummary {
  const n = evalResults.length;
  const avg = (fn: (r: EvalResult) => number) =>
    n > 0 ? evalResults.reduce((s, r) => s + fn(r), 0) / n : 0;

  return {
    configName: "quality-check",
    avgPrecision5: avg((r) => r.precision5),
    avgHitRate5: avg((r) => r.hitRate5),
    avgRecall: avg((r) => r.recall),
    avgMrr: avg((r) => r.mrr),
    avgNdcg: avg((r) => r.ndcg),
    results: evalResults,
    timestamp: new Date().toISOString(),
  };
}

/** Run all policy assertions against a summary and collect results. */
function assertPolicies(policies: QualityPolicy[], summary: EvalSummary): QualityReport["results"] {
  return policies.map((policy) => ({
    policy: policy.name,
    result: policy.assert(summary),
  }));
}

// ---------------------------------------------------------------------------
// I/O boundary
// ---------------------------------------------------------------------------

/** Safely load and parse a JSON file, returning null on failure. */
function loadJsonFileOrNull<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

export async function runQualityCheck(
  repoRoot: string,
  datasetPath?: string,
  baselinePath?: string,
): Promise<QualityReport> {
  const resolvedDataset = datasetPath ?? path.join(import.meta.dir, "../../eval/dataset.json");
  const dataset: EvalQuery[] = JSON.parse(fs.readFileSync(resolvedDataset, "utf-8"));

  // I/O: run eval
  const evalResults = await runEval(repoRoot, dataset);

  // Pure: compute summary and run assertions
  const summary = computeSummary(evalResults);

  const baselineData = baselinePath ? loadJsonFileOrNull<EvalSummary>(baselinePath) : null;

  const policies: QualityPolicy[] = [precisionAt5(0.15), mrrThreshold(0.5)];
  if (baselinePath) {
    policies.push(noRegression(baselineData));
  }

  const results = assertPolicies(policies, summary);

  return {
    passed: results.every((r) => r.result.passed),
    datasetPath: resolvedDataset,
    queryCount: dataset.length,
    results,
    timestamp: new Date().toISOString(),
  };
}
