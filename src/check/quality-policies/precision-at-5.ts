import type { QualityPolicy, QualityResult } from "../quality-types";
import type { EvalSummary } from "../../../eval/types";

export function precisionAt5(threshold: number): QualityPolicy {
  return {
    name: "precision-at-5",
    description: `Average P@5 must be >= ${threshold}`,

    assert(summary: EvalSummary): QualityResult {
      const actual = summary.avgPrecision5;
      return {
        tag: "assessed",
        passed: actual >= threshold,
        metric: "avgPrecision5",
        actual,
        threshold,
        message:
          actual >= threshold
            ? `P@5 = ${actual.toFixed(3)} >= ${threshold}`
            : `P@5 = ${actual.toFixed(3)} < ${threshold} (FAIL)`,
      };
    },
  };
}
