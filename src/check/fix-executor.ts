import type { PolicyContext, PolicyResult, FixResult } from "./types";

/**
 * Auto-fix executor for failed health policies.
 * TODO: Implement when telemetry gate passes (30+ check invocations, 5+ with fixable failures).
 * For each failed policy with a fix(), run fix in transaction, re-check, and report.
 *
 * Returns an empty array (no fixes applied) until the telemetry gate is met.
 */
export function runAutoFix(
  _ctx: PolicyContext,
  _failedPolicies: { policy: string; result: PolicyResult }[],
): Promise<FixResult[]> {
  return Promise.resolve([]);
}
