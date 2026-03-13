import type { HealthPolicy, PolicyContext, PolicyResult } from "../types";
import { pgUnsafe } from "../../db/pg";
import { getSqlite } from "../../db/sqlite";

const SUPPORTED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".cc",
  ".cxx",
  ".h",
  ".hpp",
  ".hxx",
  ".cs",
];

async function getCounts(ctx: PolicyContext): Promise<{ missing: number; total: number }> {
  const extPlaceholders = SUPPORTED_EXTENSIONS.map((_, i) =>
    ctx.store === "pg" ? `$${i + 2}` : "?",
  ).join(",");

  if (ctx.store === "pg") {
    const totalRow = (await pgUnsafe(
      `SELECT count(*)::int AS cnt FROM files WHERE repo_id = $1 AND file_type IN (${extPlaceholders})`,
      [ctx.repoId, ...SUPPORTED_EXTENSIONS],
    )) as { cnt: number }[];
    const missingRow = (await pgUnsafe(
      `SELECT count(*)::int AS cnt FROM files WHERE repo_id = $1 AND file_type IN (${extPlaceholders}) AND skeleton IS NULL`,
      [ctx.repoId, ...SUPPORTED_EXTENSIONS],
    )) as { cnt: number }[];
    return { total: totalRow[0].cnt, missing: missingRow[0].cnt };
  }

  const db = await getSqlite(ctx.repoRoot);
  const totalRow = db
    .prepare(
      `SELECT count(*) AS cnt FROM files WHERE repo_id = ? AND file_type IN (${extPlaceholders})`,
    )
    .get(ctx.repoId, ...SUPPORTED_EXTENSIONS) as { cnt: number };
  const missingRow = db
    .prepare(
      `SELECT count(*) AS cnt FROM files WHERE repo_id = ? AND file_type IN (${extPlaceholders}) AND skeleton IS NULL`,
    )
    .get(ctx.repoId, ...SUPPORTED_EXTENSIONS) as { cnt: number };
  return { total: totalRow.cnt, missing: missingRow.cnt };
}

export const skeletonFailures: HealthPolicy = {
  name: "skeleton-failures",
  description: "Check for files with supported extensions that have no skeleton",
  severity: "warning",

  async check(ctx: PolicyContext): Promise<PolicyResult> {
    const { missing, total } = await getCounts(ctx);

    if (missing === 0) {
      return { passed: true, message: `All ${total} supported files have skeletons` };
    }

    return {
      passed: false,
      message: `${missing} of ${total} supported files are missing skeletons`,
      details: { missing, total },
    };
  },
};
