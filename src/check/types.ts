import type { CodeindexConfig } from "../search/types";

export interface PolicyContext {
  repoRoot: string;
  repoId: number;
  config: CodeindexConfig;
  store: "pg" | "sqlite";
}

export interface PolicyResult {
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface FixResult {
  fixed: boolean;
  message: string;
}

export interface HealthPolicy {
  name: string;
  description: string;
  severity: "error" | "warning" | "info";
  check(ctx: PolicyContext): Promise<PolicyResult>;
  fix?(ctx: PolicyContext): Promise<FixResult>;
}

export interface CheckReport {
  repo: string;
  passed: boolean;
  results: Array<{
    policy: string;
    severity: "error" | "warning" | "info";
    result: PolicyResult;
  }>;
  timestamp: string;
}
