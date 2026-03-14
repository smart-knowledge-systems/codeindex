import fs from "fs";
import path from "path";
import { runEval } from "../../eval/run-eval";
import type { EvalQuery, EvalSummary } from "../../eval/types";
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

export async function runQualityCheck(
  repoRoot: string,
  datasetPath?: string,
  baselinePath?: string,
): Promise<QualityReport> {
  const resolvedDataset = datasetPath ?? path.join(import.meta.dir, "../../eval/dataset.json");
  const dataset: EvalQuery[] = JSON.parse(fs.readFileSync(resolvedDataset, "utf-8"));

  // Run eval
  const evalResults = await runEval(repoRoot, dataset);
  const n = evalResults.length;
  const avgPrecision5 = n > 0 ? evalResults.reduce((s, r) => s + r.precision5, 0) / n : 0;
  const avgHitRate5 = n > 0 ? evalResults.reduce((s, r) => s + r.hitRate5, 0) / n : 0;
  const avgRecall = n > 0 ? evalResults.reduce((s, r) => s + r.recall, 0) / n : 0;
  const avgMrr = n > 0 ? evalResults.reduce((s, r) => s + r.mrr, 0) / n : 0;
  const avgNdcg = n > 0 ? evalResults.reduce((s, r) => s + r.ndcg, 0) / n : 0;

  const summary: EvalSummary = {
    configName: "quality-check",
    avgPrecision5,
    avgHitRate5,
    avgRecall,
    avgMrr,
    avgNdcg,
    results: evalResults,
    timestamp: new Date().toISOString(),
  };

  // Build policies
  const policies: QualityPolicy[] = [precisionAt5(0.15), mrrThreshold(0.5)];
  if (baselinePath) {
    policies.push(noRegression(baselinePath));
  }

  // Assert
  const results: QualityReport["results"] = [];
  for (const policy of policies) {
    const result = policy.assert(summary);
    results.push({ policy: policy.name, result });
  }

  return {
    passed: results.every((r) => r.result.passed),
    datasetPath: resolvedDataset,
    queryCount: dataset.length,
    results,
    timestamp: new Date().toISOString(),
  };
}
