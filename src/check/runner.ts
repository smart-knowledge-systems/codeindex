import { loadConfig } from "../config";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import type { HealthPolicy, PolicyContext, CheckReport } from "./types";
import { indexFreshness } from "./policies/index-freshness";
import { summaryCompleteness } from "./policies/summary-completeness";
import { skeletonFailures } from "./policies/skeleton-failures";
import { reindexCompleted } from "./policies/reindex-completed";

const ALL_POLICIES: HealthPolicy[] = [
  indexFreshness,
  summaryCompleteness,
  skeletonFailures,
  reindexCompleted,
];

async function resolveRepoId(
  repoRoot: string,
  store: "pg" | "sqlite",
): Promise<{ repoId: number; repoName: string }> {
  const notIndexedError = () => new Error("Repo not indexed. Run: codeindex reindex");

  if (store === "pg") {
    const rows = (await pgUnsafe("SELECT id, name FROM repos WHERE root_path = $1", [
      repoRoot,
    ])) as { id: string; name: string }[];
    if (rows.length === 0) throw notIndexedError();
    return { repoId: parseInt(rows[0].id), repoName: rows[0].name };
  }

  const db = await getSqlite(repoRoot);
  const rows = db.prepare("SELECT id, name FROM repos WHERE root_path = ?").all(repoRoot) as {
    id: number;
    name: string;
  }[];
  if (rows.length === 0) throw notIndexedError();
  return { repoId: rows[0].id, repoName: rows[0].name };
}

export async function runHealthCheck(repoRoot: string): Promise<CheckReport> {
  const config = await loadConfig(repoRoot);
  const store = config.store;
  const { repoId, repoName } = await resolveRepoId(repoRoot, store);

  const ctx: PolicyContext = { repoRoot, repoId, config, store };

  const results = await Promise.all(
    ALL_POLICIES.map(async (policy) => ({
      policy: policy.name,
      severity: policy.severity,
      result: await policy.check(ctx),
    })),
  );

  const hasError = results.some((r) => r.severity === "error" && !r.result.passed);

  return {
    repo: repoName,
    passed: !hasError,
    results,
    timestamp: new Date().toISOString(),
  };
}
