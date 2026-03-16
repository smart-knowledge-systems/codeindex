import type { QualityPolicy, QualityResult } from "../quality-types";
import type { EvalSummary } from "../../../eval/types";

export function mrrThreshold(threshold: number): QualityPolicy {
  return {
    name: "mrr-threshold",
    description: `Average MRR must be >= ${threshold}`,

    assert(summary: EvalSummary): QualityResult {
      const actual = summary.avgMrr;
      return {
        tag: "assessed",
        passed: actual >= threshold,
        metric: "avgMrr",
        actual,
        threshold,
        message:
          actual >= threshold
            ? `MRR = ${actual.toFixed(3)} >= ${threshold}`
            : `MRR = ${actual.toFixed(3)} < ${threshold} (FAIL)`,
      };
    },
  };
}
