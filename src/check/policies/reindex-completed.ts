import type { HealthPolicy, PolicyContext, PolicyResult } from "../types";
import { storeQueryOne } from "../store-query";

async function hasEmbeddings(ctx: PolicyContext): Promise<boolean> {
  const row = await storeQueryOne<{ cnt: number }>(
    ctx,
    "SELECT count(*)::int AS cnt FROM cost_events WHERE repo_id = $1 AND operation = 'embed'",
    "SELECT count(*) AS cnt FROM cost_events WHERE repo_id = ? AND operation = 'embed'",
    [ctx.repoId],
  );
  return row!.cnt > 0;
}

export const reindexCompleted: HealthPolicy = {
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
