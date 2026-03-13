import fs from "fs";
import type { QualityPolicy, QualityResult } from "../quality-types";
import type { EvalSummary } from "../../../eval/types";

export function noRegression(baselinePath: string, tolerance = 0.02): QualityPolicy {
  return {
    name: "no-regression",
    description: `nDCG must not drop more than ${tolerance} from baseline`,

    assert(summary: EvalSummary): QualityResult {
      let baseline: EvalSummary;
      try {
        baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
      } catch {
        return {
          passed: true,
          metric: "avgNdcg",
          actual: summary.avgNdcg,
          threshold: 0,
          message: `No baseline found at ${baselinePath} — skipping regression check`,
        };
      }

      const threshold = baseline.avgNdcg - tolerance;
      const actual = summary.avgNdcg;

      return {
        passed: actual >= threshold,
        metric: "avgNdcg",
        actual,
        threshold,
        message:
          actual >= threshold
            ? `nDCG = ${actual.toFixed(3)} >= baseline ${baseline.avgNdcg.toFixed(3)} - ${tolerance}`
            : `nDCG = ${actual.toFixed(3)} < baseline ${baseline.avgNdcg.toFixed(3)} - ${tolerance} (REGRESSION)`,
      };
    },
  };
}
