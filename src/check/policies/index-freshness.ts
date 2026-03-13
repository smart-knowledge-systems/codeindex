import type { HealthPolicy, PolicyContext, PolicyResult } from "../types";
import { pgUnsafe } from "../../db/pg";
import { getSqlite } from "../../db/sqlite";

const STALE_DAYS = 7;

async function getCounts(
  ctx: PolicyContext,
  cutoffIso: string,
): Promise<{ staleCount: number; totalCount: number }> {
  if (ctx.store === "pg") {
    const total = (await pgUnsafe("SELECT count(*)::int AS cnt FROM files WHERE repo_id = $1", [
      ctx.repoId,
    ])) as { cnt: number }[];
    const stale = (await pgUnsafe(
      "SELECT count(*)::int AS cnt FROM files WHERE repo_id = $1 AND indexed_at < $2",
      [ctx.repoId, cutoffIso],
    )) as { cnt: number }[];
    return { totalCount: total[0].cnt, staleCount: stale[0].cnt };
  }

  const db = await getSqlite(ctx.repoRoot);
  const total = db
    .prepare("SELECT count(*) AS cnt FROM files WHERE repo_id = ?")
    .get(ctx.repoId) as { cnt: number };
  const stale = db
    .prepare("SELECT count(*) AS cnt FROM files WHERE repo_id = ? AND indexed_at < ?")
    .get(ctx.repoId, cutoffIso) as { cnt: number };
  return { totalCount: total.cnt, staleCount: stale.cnt };
}

export const indexFreshness: HealthPolicy = {
  name: "index-freshness",
  description: `Warn if any indexed files are older than ${STALE_DAYS} days`,
  severity: "warning",

  async check(ctx: PolicyContext): Promise<PolicyResult> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - STALE_DAYS);
    const { staleCount, totalCount } = await getCounts(ctx, cutoff.toISOString());

    if (staleCount === 0) {
      return { passed: true, message: `All ${totalCount} files indexed within ${STALE_DAYS} days` };
    }

    return {
      passed: false,
      message: `${staleCount} of ${totalCount} files indexed more than ${STALE_DAYS} days ago`,
      details: { staleCount, totalCount, staleDays: STALE_DAYS },
    };
  },
};
