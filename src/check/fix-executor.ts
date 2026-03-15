import type { PolicyContext, PolicyResult, FixResult } from "./types";

/**
 * Auto-fix executor for failed health policies.
 * TODO: Implement when telemetry gate passes (30+ check invocations, 5+ with fixable failures).
 * For each failed policy with a fix(), run fix in transaction, re-check, and report.
 *
 * Returns an empty array (no fixes applied) until the telemetry gate is met.
 */
export async function runAutoFix(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ctx: PolicyContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _failedPolicies: Array<{ policy: string; result: PolicyResult }>,
): Promise<FixResult[]> {
  return [{ fixed: false, message: "Auto-fix not yet implemented — telemetry gate not met" }];
}
