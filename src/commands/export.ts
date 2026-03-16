import { exportToSqlite, type ExportOptions } from "../db/export";
import { ensureRepo } from "./helpers";

export async function cmdExport(repoRoot: string, outPath: string, opts: ExportOptions = {}) {
  const repoId = await ensureRepo(repoRoot);
  const exportOpts: ExportOptions = { ...opts, repoRoot };
  const redactions: string[] = [];
  if (exportOpts.redactEmbeddings !== false) redactions.push("embeddings");
  if (exportOpts.redactCommits) redactions.push("commits");
  if (exportOpts.excludePatterns?.length)
    redactions.push(`exclude(${exportOpts.excludePatterns.length} patterns)`);
  console.log(`Exporting repo_id=${repoId} to ${outPath}...`);
  if (redactions.length > 0) console.log(`Redacting: ${redactions.join(", ")}`);
  await exportToSqlite(repoId, outPath, exportOpts);
  console.log("Export complete.");
}
