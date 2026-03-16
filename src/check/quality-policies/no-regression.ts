import type { QualityPolicy, QualityResult } from "../quality-types";
import type { EvalSummary } from "../../../eval/types";

/**
 * Create a no-regression policy that compares current nDCG against a baseline.
 * Baseline data is passed in directly (loaded by the caller at the I/O boundary).
 * Returns a policy indicating "baseline unavailable" if baselineData is null.
 */
export function noRegression(baselineData: EvalSummary | null, tolerance = 0.02): QualityPolicy {
  return {
    name: "no-regression",
    description: `nDCG must not drop more than ${tolerance} from baseline`,

    assert(summary: EvalSummary): QualityResult {
      if (!baselineData) {
        return {
          tag: "error",
          passed: false,
          metric: "avgNdcg",
          actual: summary.avgNdcg,
          threshold: 0,
          message: "Baseline data unavailable — cannot verify regression",
        };
      }

      const threshold = baselineData.avgNdcg - tolerance;
      const actual = summary.avgNdcg;

      return {
        tag: "assessed",
        passed: actual >= threshold,
        metric: "avgNdcg",
        actual,
        threshold,
        message:
          actual >= threshold
            ? `nDCG = ${actual.toFixed(3)} >= baseline ${baselineData.avgNdcg.toFixed(3)} - ${tolerance}`
            : `nDCG = ${actual.toFixed(3)} < baseline ${baselineData.avgNdcg.toFixed(3)} - ${tolerance} (REGRESSION)`,
      };
    },
  };
}
