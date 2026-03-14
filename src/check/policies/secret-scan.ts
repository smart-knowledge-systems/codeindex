import type { HealthPolicy, PolicyContext, PolicyResult } from "../types";
import { pgUnsafe } from "../../db/pg";
import { getSqlite } from "../../db/sqlite";

async function hasEmbeddings(ctx: PolicyContext): Promise<boolean> {
  if (ctx.store === "pg") {
    const rows = (await pgUnsafe(
      "SELECT count(*)::int AS cnt FROM cost_events WHERE repo_id = $1 AND operation = 'embed'",
      [ctx.repoId],
    )) as { cnt: number }[];
    return rows[0].cnt > 0;
  }

  const db = await getSqlite(ctx.repoRoot);
  const row = db
    .prepare("SELECT count(*) AS cnt FROM cost_events WHERE repo_id = ? AND operation = 'embed'")
    .get(ctx.repoId) as { cnt: number };
  return row.cnt > 0;
}

export const secretScanCoverage: HealthPolicy = {
  name: "reindex-completed",
  description: "Verify that the repo has been fully indexed (embedding events exist)",
  severity: "error",

  async check(ctx: PolicyContext): Promise<PolicyResult> {
    const hasEvents = await hasEmbeddings(ctx);

    if (!hasEvents) {
      return {
        passed: false,
        message: "No embedding events found — repo has not been indexed",
        details: { note: "Run `codeindex reindex` to index the repo" },
      };
    }

    return {
      passed: true,
      message: "Reindex completed (embedding events found)",
    };
  },
};
