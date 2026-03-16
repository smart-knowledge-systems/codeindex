import { loadConfig } from "../config";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { requireRepoId } from "../db/repo-lookup";
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
  const repoId = await requireRepoId(repoRoot);

  // Fetch the repo name
  if (store === "pg") {
    const rows = (await pgUnsafe("SELECT name FROM repos WHERE id = $1", [repoId])) as {
      name: string;
    }[];
    if (rows.length === 0) throw new Error("Repo not indexed. Run: codeindex reindex");
    return { repoId, repoName: rows[0].name };
  }

  const db = await getSqlite(repoRoot);
  const row = db.prepare("SELECT name FROM repos WHERE id = ?").get(repoId) as { name: string } | null;
  if (!row) throw new Error("Repo not indexed. Run: codeindex reindex");
  return { repoId, repoName: row.name };
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
