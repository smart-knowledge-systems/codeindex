import { loadConfig } from "../config";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { runQualityCheck } from "../check/quality-runner";

// ---------------------------------------------------------------------------
// Pure formatters for status output (Issue 5: separate formatting from I/O)
// ---------------------------------------------------------------------------

export interface StatusData {
  name: string;
  rootPath: string;
  store: string;
  fileCount: number;
  dirCount: number;
  commitCount: number;
  lastIndexed: string | null;
  formatter: string | null;
}

export function formatStatusLines(data: StatusData): string[] {
  return [
    `Repo: ${data.name} (${data.rootPath})`,
    `Store: ${data.store}`,
    `Files: ${data.fileCount}`,
    `Directories: ${data.dirCount}`,
    `Commits: ${data.commitCount}`,
    `Last indexed: ${data.lastIndexed ?? "never"}`,
    `Formatter: ${data.formatter ?? "auto-detect"}`,
  ];
}

export interface CostRow {
  operation: string;
  model: string;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
}

export function formatCostLines(costRows: CostRow[]): string[] {
  if (costRows.length === 0) return ["\nCost: no cost events recorded"];
  const header = [
    "\nCost breakdown:",
    "  Operation       Model                  Tokens In   Tokens Out   Cost (USD)",
    "  " + "-".repeat(75),
  ];
  const rows = costRows.map((row) => {
    const op = row.operation.padEnd(15);
    const model = row.model.padEnd(22);
    const tokIn = String(row.totalTokensIn).padStart(10);
    const tokOut = String(row.totalTokensOut).padStart(12);
    const cost = `$${row.totalCostUsd.toFixed(4)}`.padStart(11);
    return `  ${op} ${model} ${tokIn} ${tokOut} ${cost}`;
  });
  const totalCost = costRows.reduce((sum, r) => sum + r.totalCostUsd, 0);
  const footer = ["  " + "-".repeat(75), `  Total: $${totalCost.toFixed(4)}`];
  return [...header, ...rows, ...footer];
}

export async function cmdStatus(repoRoot: string, showCost = false, showQuality = false) {
  const config = await loadConfig(repoRoot);

  // Fetch status data from the appropriate store
  const statusData: StatusData | null = await (async () => {
    if (config.store === "pg") {
      const repos = await pgUnsafe("SELECT * FROM repos WHERE root_path = $1", [repoRoot]);
      if (repos.length === 0) return null;
      const repoId = repos[0].id;
      const fileCount = await pgUnsafe("SELECT count(*) as cnt FROM files WHERE repo_id = $1", [
        repoId,
      ]);
      const dirCount = await pgUnsafe(
        "SELECT count(*) as cnt FROM directories WHERE repo_id = $1",
        [repoId],
      );
      const commitCount = await pgUnsafe("SELECT count(*) as cnt FROM commits WHERE repo_id = $1", [
        repoId,
      ]);
      const lastIndexed = await pgUnsafe(
        "SELECT max(indexed_at) as last FROM files WHERE repo_id = $1",
        [repoId],
      );
      return {
        name: repos[0].name as string,
        rootPath: repos[0].root_path as string,
        store: "PostgreSQL",
        fileCount: parseInt(fileCount[0].cnt as string),
        dirCount: parseInt(dirCount[0].cnt as string),
        commitCount: parseInt(commitCount[0].cnt as string),
        lastIndexed: (lastIndexed[0].last as string | null) ?? null,
        formatter: (repos[0].formatter_cmd as string | null) ?? null,
      };
    } else {
      const db = await getSqlite(repoRoot);
      const repos = db.prepare("SELECT * FROM repos WHERE root_path = ?").all(repoRoot) as {
        id: number;
        name: string;
        root_path: string;
        formatter_cmd: string | null;
      }[];
      if (repos.length === 0) return null;
      const repoId = repos[0].id;
      const fileCount = db
        .prepare("SELECT count(*) as cnt FROM files WHERE repo_id = ?")
        .get(repoId) as { cnt: number };
      const dirCount = db
        .prepare("SELECT count(*) as cnt FROM directories WHERE repo_id = ?")
        .get(repoId) as { cnt: number };
      const commitCount = db
        .prepare("SELECT count(*) as cnt FROM commits WHERE repo_id = ?")
        .get(repoId) as { cnt: number };
      const lastIndexed = db
        .prepare("SELECT max(indexed_at) as last FROM files WHERE repo_id = ?")
        .get(repoId) as { last: string | null };
      return {
        name: repos[0].name,
        rootPath: repos[0].root_path,
        store: "SQLite",
        fileCount: fileCount.cnt,
        dirCount: dirCount.cnt,
        commitCount: commitCount.cnt,
        lastIndexed: lastIndexed.last,
        formatter: repos[0].formatter_cmd,
      };
    }
  })();

  if (!statusData) {
    console.log("Not indexed yet. Run: codeindex reindex");
    return;
  }

  // Pure formatting → impure output
  formatStatusLines(statusData).forEach((line) => console.log(line));

  // Cost tracking output
  if (showCost) {
    const { getCostSummary } = await import("../cost");
    const costRows = await getCostSummary(repoRoot);
    formatCostLines(costRows).forEach((line) => console.log(line));
  }

  // Quality metrics
  if (showQuality) {
    try {
      const report = await runQualityCheck(repoRoot);
      console.log("\nQuality Report:");
      console.log(`  Status: ${report.passed ? "PASS" : "FAIL"}`);
      console.log(`  Dataset queries: ${report.queryCount}`);
      for (const r of report.results) {
        const icon = r.result.passed ? "PASS" : "FAIL";
        console.log(`  [${icon}] ${r.policy}: ${r.result.message}`);
      }
    } catch (err) {
      console.log(`\nQuality check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
