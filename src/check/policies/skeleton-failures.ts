import type { HealthPolicy, PolicyContext, PolicyResult } from "../types";
import { storeQueryOne } from "../store-query";

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
  ".kt",
  ".kts",
  ".swift",
  ".rb",
  ".php",
];

/** Build parameterized placeholders for the extension list. */
function extPlaceholders(store: "pg" | "sqlite"): string {
  return SUPPORTED_EXTENSIONS.map((_, i) => (store === "pg" ? `$${i + 2}` : "?")).join(",");
}

async function getCounts(ctx: PolicyContext): Promise<{ missing: number; total: number }> {
  const placeholders = extPlaceholders(ctx.store);
  const params = [ctx.repoId, ...SUPPORTED_EXTENSIONS];

  const totalRow = await storeQueryOne<{ cnt: number }>(
    ctx,
    `SELECT count(*)::int AS cnt FROM files WHERE repo_id = $1 AND file_type IN (${placeholders})`,
    `SELECT count(*) AS cnt FROM files WHERE repo_id = ? AND file_type IN (${placeholders})`,
    params,
  );
  const missingRow = await storeQueryOne<{ cnt: number }>(
    ctx,
    `SELECT count(*)::int AS cnt FROM files WHERE repo_id = $1 AND file_type IN (${placeholders}) AND skeleton IS NULL`,
    `SELECT count(*) AS cnt FROM files WHERE repo_id = ? AND file_type IN (${placeholders}) AND skeleton IS NULL`,
    params,
  );
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
