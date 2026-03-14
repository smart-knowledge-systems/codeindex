import type { PolicyContext, PolicyResult } from "./types";

export interface FixResult {
  fixed: boolean;
  message: string;
}

/**
import type { PolicyContext, PolicyResult, FixResult } from "./types";

export async function runAutoFix(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ctx: PolicyContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _failedPolicies: Array<{ policy: string; result: PolicyResult }>,
): Promise<FixResult[]> {
  // Passthrough — telemetry gate not met
  return [];
}
