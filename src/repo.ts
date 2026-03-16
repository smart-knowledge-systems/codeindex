import path from "path";
import { existsSync } from "fs";
import { loadConfig } from "./config";
import { getPg, pgUnsafe } from "./db/pg";
import { getSqlite } from "./db/sqlite";
import { ensurePgSchema, ensureSqliteSchema } from "./db/schema";
import { getRepoOrigin, getRepoName } from "./index/commits";
import { logEvent } from "./logging";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface RepoRow {
  id: number | string;
  origin_url: string | null;
  root_path: string;
  name: string;
  formatter_cmd: string | null;
}

interface CountRow {
  count: number | string;
}

interface ListRow {
  id: number | string;
  name: string;
  root_path: string;
  file_count: number | string;
  last_indexed: string | null;
}

// ---------------------------------------------------------------------------
// Store abstraction — eliminates repeated pg/sqlite branching
// ---------------------------------------------------------------------------

interface StoreOps {
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  run: (sql: string, params?: unknown[]) => Promise<void>;
}

/**
 * Create a store-agnostic query interface based on configuration.
 * All DB operations in this module flow through this adapter.
 */
async function getStoreOps(repoRoot: string): Promise<{ store: string; ops: StoreOps }> {
  const config = await loadConfig(repoRoot);

  if (config.store === "pg") {
    return {
      store: "pg",
      ops: {
        query: async <T>(sql: string, params?: unknown[]) => (await pgUnsafe(sql, params)) as T[],
        run: async (sql: string, params?: unknown[]) => {
          await pgUnsafe(sql, params);
        },
      },
    };
  }

  const db = await getSqlite(repoRoot);
  type SqlBindings = (string | number | bigint | boolean | null | Uint8Array)[];
  return {
    store: "sqlite",
    ops: {
      query: async <T>(sql: string, params?: unknown[]) =>
        db.prepare(sql).all(...((params ?? []) as SqlBindings)) as T[],
      run: async (sql: string, params?: unknown[]) => {
        db.prepare(sql).run(...((params ?? []) as SqlBindings));
      },
    },
  };
}

// ---------------------------------------------------------------------------
// repoAdd
// ---------------------------------------------------------------------------

export async function repoAdd(repoRoot: string, targetPath: string): Promise<void> {
  const absPath = path.resolve(targetPath);
  const gitHead = path.join(absPath, ".git", "HEAD");
  if (!existsSync(gitHead)) {
    throw new Error(`Not a git repository: ${absPath}`);
  }

  const config = await loadConfig(repoRoot);

  if (config.store === "pg") {
    await ensurePgSchema();
  } else {
    await ensureSqliteSchema(repoRoot);
  }

  const originUrl = (await getRepoOrigin(absPath)) ?? "";
  const name = await getRepoName(absPath);
  const { ops } = await getStoreOps(repoRoot);

  await ops.run(
    config.store === "pg"
      ? `INSERT INTO repos (origin_url, root_path, name) VALUES ($1, $2, $3)`
      : `INSERT INTO repos (origin_url, root_path, name) VALUES (?, ?, ?)`,
    [originUrl, absPath, name],
  );

  logEvent({ event: "infra.repo.add", repo_name: name });
}

// ---------------------------------------------------------------------------
// repoAddBulk
// ---------------------------------------------------------------------------

export interface BulkAddResult {
  name: string;
  path: string;
  status: "added" | "exists" | "error";
  error?: string;
}

/**
 * Pure: validate that a path is a git repository.
 */
function validateGitRepo(absPath: string): string | null {
  const gitHead = path.join(absPath, ".git", "HEAD");
  return existsSync(gitHead) ? null : "not a git repo";
}

/**
 * Process a single repo for bulk add against a store-agnostic interface.
 */
async function processOneRepo(
  absPath: string,
  ops: StoreOps,
  placeholder: (n: number) => string,
): Promise<BulkAddResult> {
  const validationError = validateGitRepo(absPath);
  if (validationError) {
    return { name: path.basename(absPath), path: absPath, status: "error", error: validationError };
  }

  const existing = await ops.query<{ id: number | string }>(
    `SELECT id FROM repos WHERE root_path = ${placeholder(1)}`,
    [absPath],
  );
  if (existing.length > 0) {
    const repoName = await getRepoName(absPath);
    return { name: repoName, path: absPath, status: "exists" };
  }

  const originUrl = (await getRepoOrigin(absPath)) ?? "";
  const name = await getRepoName(absPath);
  await ops.run(
    `INSERT INTO repos (origin_url, root_path, name) VALUES (${placeholder(1)}, ${placeholder(2)}, ${placeholder(3)})`,
    [originUrl, absPath, name],
  );
  return { name, path: absPath, status: "added" };
}

export async function repoAddBulk(repoRoot: string, paths: string[]): Promise<BulkAddResult[]> {
  const config = await loadConfig(repoRoot);
  const isPg = config.store === "pg";

  if (isPg) {
    await ensurePgSchema();
  } else {
    await ensureSqliteSchema(repoRoot);
  }

  const { ops } = await getStoreOps(repoRoot);
  const placeholder = isPg ? (n: number) => `$${n}` : () => "?";

  const results: BulkAddResult[] = [];
  for (const targetPath of paths) {
    const absPath = path.resolve(targetPath);
    try {
      const result = await processOneRepo(absPath, ops, placeholder);
      results.push(result);
    } catch (err) {
      results.push({
        name: path.basename(absPath),
        path: absPath,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// repoRemove
// ---------------------------------------------------------------------------

async function removePgRepo(repoId: number): Promise<void> {
  const pg = await getPg();
  await pg.begin(async (tx) => {
    await tx.unsafe(`DELETE FROM cost_events WHERE repo_id = $1`, [repoId]);
    await tx.unsafe(
      `DELETE FROM file_commits WHERE file_id IN (SELECT id FROM files WHERE repo_id = $1)`,
      [repoId],
    );
    await tx.unsafe(`DELETE FROM files WHERE repo_id = $1`, [repoId]);
    await tx.unsafe(`DELETE FROM directories WHERE repo_id = $1`, [repoId]);
    await tx.unsafe(`DELETE FROM commits WHERE repo_id = $1`, [repoId]);
    await tx.unsafe(`DELETE FROM repos WHERE id = $1`, [repoId]);
  });
}

async function removeSqliteRepo(repoRoot: string, repoId: number): Promise<void> {
  const db = await getSqlite(repoRoot);

  const fileIds = (
    db.prepare(`SELECT id FROM files WHERE repo_id = ?`).all(repoId) as { id: number }[]
  ).map((r) => r.id);
  const dirIds = (
    db.prepare(`SELECT id FROM directories WHERE repo_id = ?`).all(repoId) as { id: number }[]
  ).map((r) => r.id);
  const commitIds = (
    db.prepare(`SELECT id FROM commits WHERE repo_id = ?`).all(repoId) as { id: number }[]
  ).map((r) => r.id);

  const deleteVec0ByIds = (table: string, column: string, ids: number[]) => {
    const stmt = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`);
    for (const id of ids) stmt.run(id);
  };

  db.transaction(() => {
    deleteVec0ByIds("file_embeddings", "file_id", fileIds);
    deleteVec0ByIds("dir_concat_embeddings", "dir_id", dirIds);
    deleteVec0ByIds("dir_summary_embeddings", "dir_id", dirIds);
    deleteVec0ByIds("commit_embeddings", "commit_id", commitIds);

    db.prepare(`DELETE FROM cost_events WHERE repo_id = ?`).run(repoId);
    db.prepare(
      `DELETE FROM file_commits WHERE file_id IN (SELECT id FROM files WHERE repo_id = ?)`,
    ).run(repoId);
    db.prepare(`DELETE FROM files WHERE repo_id = ?`).run(repoId);
    db.prepare(`DELETE FROM directories WHERE repo_id = ?`).run(repoId);
    db.prepare(`DELETE FROM commits WHERE repo_id = ?`).run(repoId);
    db.prepare(`DELETE FROM repos WHERE id = ?`).run(repoId);
  })();
}

export async function repoRemove(repoRoot: string, name: string): Promise<void> {
  const { store, ops } = await getStoreOps(repoRoot);
  const isPg = store === "pg";
  const ph = isPg ? "$1" : "?";

  const repos = await ops.query<{ id: number | string }>(
    `SELECT id FROM repos WHERE name = ${ph}`,
    [name],
  );
  if (repos.length === 0) throw new Error(`Repo not found: ${name}`);
  const repoId = typeof repos[0].id === "string" ? parseInt(repos[0].id) : repos[0].id;

  if (isPg) {
    await removePgRepo(repoId);
  } else {
    await removeSqliteRepo(repoRoot, repoId);
  }

  logEvent({ event: "infra.repo.remove", repo_name: name });
}

// ---------------------------------------------------------------------------
// repoGetByName / repoGetAll — return registered repos as data
// ---------------------------------------------------------------------------

export async function repoGetByName(
  repoRoot: string,
  name: string,
): Promise<{ name: string; root_path: string } | null> {
  const { store, ops } = await getStoreOps(repoRoot);
  const ph = store === "pg" ? "$1" : "?";
  const rows = await ops.query<{ name: string; root_path: string }>(
    `SELECT name, root_path FROM repos WHERE name = ${ph}`,
    [name],
  );
  return rows[0] ?? null;
}

export async function repoGetAll(repoRoot: string): Promise<{ name: string; root_path: string }[]> {
  const { ops } = await getStoreOps(repoRoot);
  return ops.query<{ name: string; root_path: string }>(
    `SELECT name, root_path FROM repos ORDER BY id`,
  );
}

// ---------------------------------------------------------------------------
// repoList
// ---------------------------------------------------------------------------

function printRepoTable(
  rows: { id: string; name: string; root_path: string; file_count: string; last_indexed: string }[],
): void {
  const header = `${"ID".padEnd(4)}${"Name".padEnd(18)}${"Path".padEnd(30)}${"Files".padEnd(7)}Last Indexed`;
  console.log(header);
  for (const r of rows) {
    console.log(
      `${String(r.id).padEnd(4)}${String(r.name).padEnd(18)}${String(r.root_path).padEnd(30)}${String(r.file_count).padEnd(7)}${String(r.last_indexed)}`,
    );
  }
}

export async function repoList(repoRoot: string): Promise<void> {
  const { ops } = await getStoreOps(repoRoot);
  const rows = await ops.query<ListRow>(
    `SELECT r.id, r.name, r.root_path,
            COUNT(f.id) AS file_count,
            MAX(f.indexed_at) AS last_indexed
     FROM repos r
     LEFT JOIN files f ON f.repo_id = r.id
     GROUP BY r.id, r.name, r.root_path
     ORDER BY r.id`,
  );

  printRepoTable(
    rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      root_path: r.root_path,
      file_count: String(r.file_count),
      last_indexed: r.last_indexed ?? "-",
    })),
  );
}

// ---------------------------------------------------------------------------
// repoStatus
// ---------------------------------------------------------------------------

interface StatusData {
  repo: RepoRow;
  fileCount: string;
  dirCount: string;
  commitCount: string;
  lastIndexed: string;
}

async function fetchRepoStatus(
  ops: StoreOps,
  repoRoot: string,
  isPg: boolean,
  name?: string,
): Promise<StatusData> {
  const ph = isPg ? "$1" : "?";
  const castText = isPg ? "::text" : "";

  const whereClause = name ? `WHERE name = ${ph}` : `WHERE root_path = ${ph}`;
  const param = name ?? repoRoot;
  const errorMsg = name ? `Repo not found: ${name}` : `Repo not found for path: ${repoRoot}`;

  const repos = await ops.query<RepoRow>(
    `SELECT id, origin_url, root_path, name, formatter_cmd FROM repos ${whereClause}`,
    [param],
  );
  if (repos.length === 0) throw new Error(errorMsg);
  const repo = repos[0];

  const repoId = typeof repo.id === "string" ? parseInt(repo.id) : repo.id;

  const countQuery = (table: string, col = "*") =>
    ops.query<CountRow>(
      `SELECT COUNT(${col})${castText} AS count FROM ${table} WHERE repo_id = ${ph}`,
      [repoId],
    );

  const [fileCounts, dirCounts, commitCounts, lastIndexedRows] = await Promise.all([
    countQuery("files"),
    countQuery("directories"),
    countQuery("commits"),
    ops.query<CountRow>(
      `SELECT MAX(indexed_at)${castText} AS count FROM files WHERE repo_id = ${ph}`,
      [repoId],
    ),
  ]);

  return {
    repo,
    fileCount: String(fileCounts[0].count),
    dirCount: String(dirCounts[0].count),
    commitCount: String(commitCounts[0].count),
    lastIndexed: lastIndexedRows[0].count != null ? String(lastIndexedRows[0].count) : "-",
  };
}

function printStatus(data: StatusData, store: string): void {
  const { repo, fileCount, dirCount, commitCount, lastIndexed } = data;
  console.log(`Name:         ${repo.name}`);
  console.log(`Path:         ${repo.root_path}`);
  console.log(`Origin:       ${repo.origin_url ?? "-"}`);
  console.log(`Store:        ${store}`);
  console.log(`Files:        ${fileCount}`);
  console.log(`Directories:  ${dirCount}`);
  console.log(`Commits:      ${commitCount}`);
  console.log(`Last Indexed: ${lastIndexed}`);
  console.log(`Formatter:    ${repo.formatter_cmd ?? "-"}`);
}

export async function repoStatus(repoRoot: string, name?: string): Promise<void> {
  const { store, ops } = await getStoreOps(repoRoot);
  const data = await fetchRepoStatus(ops, repoRoot, store === "pg", name);
  printStatus(data, store);
}

// ---------------------------------------------------------------------------
// repoPurge
// ---------------------------------------------------------------------------

export async function repoPurge(repoRoot: string, name: string, force?: boolean): Promise<void> {
  if (!force) {
    process.stdout.write(`Are you sure you want to purge repo "${name}"? (y/N) `);
    const response = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      process.stdin.once("data", (data: Buffer) => {
        chunks.push(data);
        resolve(Buffer.concat(chunks).toString().trim());
      });
    });
    if (response.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  await repoRemove(repoRoot, name);
}
