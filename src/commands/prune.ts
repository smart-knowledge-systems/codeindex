/**
 * `codeindex prune` — remove orphaned rows from the index.
 *
 * Scans for:
 *   1. Repos whose root_path no longer exists on disk
 *   2. files / commits / directories / cost_events rows whose repo_id
 *      references a non-existent repo
 *   3. file_commits / file_imports rows that reference non-existent
 *      files or commits
 *
 * The sweep is FK-aware and deletes in dependency order so it never
 * violates referential integrity or silently drops deduplicated data
 * (file_blobs are untouched — use `dedup gc` for that).
 */

import { existsSync } from "fs";
import { getStoreOps, repoRemove } from "../repo";
import { logEvent } from "../logging";

interface CmdOptions {
  json?: boolean;
  dryRun?: boolean;
}

interface PruneResult {
  repos: number;
  files: number;
  commits: number;
  directories: number;
  costEvents: number;
  fileCommits: number;
  fileImports: number;
  crossRepoEdges: number;
}

interface DeadRepo {
  id: number;
  name: string;
}

/**
 * Identify repos whose root_path no longer exists on disk.
 */
async function findDeadRepos(ops: {
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
}): Promise<DeadRepo[]> {
  const repos = await ops.query<{ id: number | string; name: string; root_path: string }>(
    `SELECT id, name, root_path FROM repos`,
  );
  return repos
    .filter((r) => !existsSync(r.root_path))
    .map((r) => ({
      id: typeof r.id === "string" ? parseInt(r.id) : r.id,
      name: r.name,
    }));
}

/**
 * Count orphaned rows across all tables. An orphan is a row that references
 * a parent (repo, file, commit) that no longer exists.
 */
async function countOrphans(
  ops: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> },
  deadRepos: DeadRepo[],
): Promise<PruneResult> {
  const count = async (sql: string) => {
    const rows = await ops.query<{ count: number | string }>(sql);
    return Number(rows[0].count);
  };

  const deadIds = deadRepos.map((r) => r.id);

  // Rows in tables that lack ON DELETE CASCADE from repos
  const files = await count(
    `SELECT COUNT(*) AS count FROM files WHERE repo_id NOT IN (SELECT id FROM repos)`,
  );
  const commits = await count(
    `SELECT COUNT(*) AS count FROM commits WHERE repo_id NOT IN (SELECT id FROM repos)`,
  );
  const directories = await count(
    `SELECT COUNT(*) AS count FROM directories WHERE repo_id NOT IN (SELECT id FROM repos)`,
  );
  const costEvents = await count(
    `SELECT COUNT(*) AS count FROM cost_events WHERE repo_id NOT IN (SELECT id FROM repos)`,
  );

  // Join-table orphans: reference a file or commit that doesn't exist
  const fileCommits = await count(
    `SELECT COUNT(*) AS count FROM file_commits WHERE file_id NOT IN (SELECT id FROM files) OR commit_id NOT IN (SELECT id FROM commits)`,
  );

  // file_imports / cross_repo_edges that are already orphaned
  let fileImports = await count(
    `SELECT COUNT(*) AS count FROM file_imports WHERE source_file_id NOT IN (SELECT id FROM files)`,
  );
  let crossRepoEdges = await count(
    `SELECT COUNT(*) AS count FROM cross_repo_edges WHERE source_repo_id NOT IN (SELECT id FROM repos) OR target_repo_id NOT IN (SELECT id FROM repos) OR source_file_id NOT IN (SELECT id FROM files)`,
  );

  // Also count rows that will become orphaned after phase 1 removes dead repos.
  // Without this, --dry-run undercounts because the parent rows still exist.
  if (deadIds.length > 0) {
    const idList = deadIds.join(",");
    fileImports += await count(
      `SELECT COUNT(*) AS count FROM file_imports
       WHERE source_file_id IN (SELECT id FROM files WHERE repo_id IN (${idList}))`,
    );
    crossRepoEdges += await count(
      `SELECT COUNT(*) AS count FROM cross_repo_edges
       WHERE source_repo_id IN (${idList}) OR target_repo_id IN (${idList})`,
    );
  }

  return {
    repos: deadRepos.length,
    files,
    commits,
    directories,
    costEvents,
    fileCommits,
    fileImports,
    crossRepoEdges,
  };
}

/**
 * Delete orphans in two phases:
 *   1. Remove dead repos via repoRemove() — this handles the full cascade
 *      (files, commits, directories, cost_events, file_commits, embeddings)
 *      plus dedup unlink (repo_packages).
 *   2. Sweep any remaining dangling join-table rows that reference
 *      non-existent parents (e.g. left behind by earlier partial deletes).
 */
async function deleteOrphans(
  repoRoot: string,
  ops: {
    run: (sql: string, params?: unknown[]) => Promise<void>;
  },
  deadRepos: DeadRepo[],
): Promise<void> {
  // Phase 1: full cascade delete for each dead repo
  for (const repo of deadRepos) {
    await repoRemove(repoRoot, repo.name);
  }

  // Phase 2: sweep any remaining dangling rows (from prior partial deletes)
  // NOTE: vec0 embedding tables (file_embeddings, dir_concat_embeddings,
  // dir_summary_embeddings, commit_embeddings) are NOT swept here because
  // sqlite-vec doesn't support NOT IN subqueries. Phase 1's repoRemove()
  // handles embeddings for dead repos; stale rows from earlier partial
  // deletes may accumulate in SQLite stores. See: TODO(prune-vec0-orphans)
  await ops.run(
    `DELETE FROM file_commits WHERE file_id NOT IN (SELECT id FROM files) OR commit_id NOT IN (SELECT id FROM commits)`,
  );
  await ops.run(`DELETE FROM file_imports WHERE source_file_id NOT IN (SELECT id FROM files)`);
  await ops.run(
    `DELETE FROM cross_repo_edges WHERE source_repo_id NOT IN (SELECT id FROM repos) OR target_repo_id NOT IN (SELECT id FROM repos) OR source_file_id NOT IN (SELECT id FROM files)`,
  );
  await ops.run(`DELETE FROM cost_events WHERE repo_id NOT IN (SELECT id FROM repos)`);
  await ops.run(`DELETE FROM files WHERE repo_id NOT IN (SELECT id FROM repos)`);
  await ops.run(`DELETE FROM commits WHERE repo_id NOT IN (SELECT id FROM repos)`);
  await ops.run(`DELETE FROM directories WHERE repo_id NOT IN (SELECT id FROM repos)`);
}

function printPlan(result: PruneResult, verb: string): void {
  const total =
    result.repos +
    result.files +
    result.commits +
    result.directories +
    result.costEvents +
    result.fileCommits +
    result.fileImports +
    result.crossRepoEdges;

  if (total === 0) {
    console.log("No orphaned rows found — index is clean.");
    return;
  }

  console.log(`${verb}:`);
  if (result.repos > 0) console.log(`  ${result.repos} dead repo(s) (root_path missing from disk)`);
  if (result.fileCommits > 0) console.log(`  ${result.fileCommits} orphaned file_commits row(s)`);
  if (result.fileImports > 0) console.log(`  ${result.fileImports} orphaned file_imports row(s)`);
  if (result.crossRepoEdges > 0)
    console.log(`  ${result.crossRepoEdges} orphaned cross_repo_edges row(s)`);
  if (result.files > 0) console.log(`  ${result.files} orphaned files row(s)`);
  if (result.commits > 0) console.log(`  ${result.commits} orphaned commits row(s)`);
  if (result.directories > 0) console.log(`  ${result.directories} orphaned directories row(s)`);
  if (result.costEvents > 0) console.log(`  ${result.costEvents} orphaned cost_events row(s)`);
}

export async function cmdPrune(repoRoot: string, opts: CmdOptions = {}): Promise<void> {
  const { ops } = await getStoreOps(repoRoot);
  const dryRun = opts.dryRun ?? false;

  const deadRepos = await findDeadRepos(ops);
  const plan = await countOrphans(ops, deadRepos);

  if (dryRun) {
    if (opts.json) {
      console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
    } else {
      printPlan(plan, "Would delete");
    }
    return;
  }

  const total =
    plan.repos +
    plan.files +
    plan.commits +
    plan.directories +
    plan.costEvents +
    plan.fileCommits +
    plan.fileImports +
    plan.crossRepoEdges;

  if (total === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ dryRun: false, ...plan }, null, 2));
    } else {
      console.log("No orphaned rows found — index is clean.");
    }
    return;
  }

  await deleteOrphans(repoRoot, ops, deadRepos);

  if (opts.json) {
    console.log(JSON.stringify({ dryRun: false, ...plan }, null, 2));
  } else {
    printPlan(plan, "Deleted");
  }

  logEvent({
    event: "infra.prune.orphans",
    dead_repo_names: deadRepos.map((r) => r.name),
    dead_repos: plan.repos,
    orphaned_files: plan.files,
    orphaned_commits: plan.commits,
    orphaned_directories: plan.directories,
    orphaned_cost_events: plan.costEvents,
    orphaned_file_commits: plan.fileCommits,
    orphaned_file_imports: plan.fileImports,
    orphaned_cross_repo_edges: plan.crossRepoEdges,
  });
}
