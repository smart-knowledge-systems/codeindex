import type { HealthPolicy, PolicyContext, PolicyResult } from "../types";
import { pgUnsafe } from "../../db/pg";
import { getSqlite } from "../../db/sqlite";

const MIN_COMPLETENESS = 0.8;

async function getCounts(ctx: PolicyContext): Promise<{ totalDirs: number; withSummary: number }> {
  if (ctx.store === "pg") {
    const total = (await pgUnsafe(
      "SELECT count(*)::int AS cnt FROM directories WHERE repo_id = $1",
      [ctx.repoId],
    )) as { cnt: number }[];
    const summarized = (await pgUnsafe(
      "SELECT count(*)::int AS cnt FROM directories WHERE repo_id = $1 AND summary IS NOT NULL",
      [ctx.repoId],
    )) as { cnt: number }[];
    return { totalDirs: total[0].cnt, withSummary: summarized[0].cnt };
  }

  const db = await getSqlite(ctx.repoRoot);
  const total = db
    .prepare("SELECT count(*) AS cnt FROM directories WHERE repo_id = ?")
    .get(ctx.repoId) as { cnt: number };
  const summarized = db
    .prepare("SELECT count(*) AS cnt FROM directories WHERE repo_id = ? AND summary IS NOT NULL")
    .get(ctx.repoId) as { cnt: number };
  return { totalDirs: total.cnt, withSummary: summarized.cnt };
}

export const summaryCompleteness: HealthPolicy = {
  name: "summary-completeness",
  description: `Check that at least ${MIN_COMPLETENESS * 100}% of directories have summaries`,
  severity: "warning",

  async check(ctx: PolicyContext): Promise<PolicyResult> {
    const { totalDirs, withSummary } = await getCounts(ctx);

    if (totalDirs === 0) {
      return { passed: true, message: "No directories indexed" };
    }

    const ratio = withSummary / totalDirs;
    const passed = ratio >= MIN_COMPLETENESS;

    return {
      passed,
      message: `${withSummary}/${totalDirs} directories have summaries (${(ratio * 100).toFixed(1)}%)`,
      details: { totalDirs, withSummary, ratio, threshold: MIN_COMPLETENESS },
    };
  },
};
