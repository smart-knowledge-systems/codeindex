import path from "path";
import { existsSync } from "fs";
import { loadConfig } from "./config";
import { getPg, pgUnsafe } from "./db/pg";
import { getSqlite } from "./db/sqlite";
import { getRepoOrigin, getRepoName } from "./index/commits";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface PgRepoRow {
  id: string;
  origin_url: string | null;
  root_path: string;
  name: string;
  formatter_cmd: string | null;
}

interface SqliteRepoRow {
  id: number;
  origin_url: string | null;
  root_path: string;
  name: string;
  formatter_cmd: string | null;
}

interface CountRow {
  count: number | string;
}

interface PgListRow {
  id: string;
  name: string;
  root_path: string;
  file_count: string;
  last_indexed: string | null;
}

interface SqliteListRow {
  id: number;
  name: string;
  root_path: string;
  file_count: number;
  last_indexed: string | null;
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
  const originUrl = (await getRepoOrigin(absPath)) ?? "";
  const name = await getRepoName(absPath);

  if (config.store === "pg") {
    await pgUnsafe(`INSERT INTO repos (origin_url, root_path, name) VALUES ($1, $2, $3)`, [
      originUrl,
      absPath,
      name,
    ]);
  } else {
    const db = await getSqlite(repoRoot);
    db.prepare(`INSERT INTO repos (origin_url, root_path, name) VALUES (?, ?, ?)`).run(
      originUrl,
      absPath,
      name,
    );
  }

  console.log(`Added repo: ${name} (${absPath})`);
}

// ---------------------------------------------------------------------------
// repoRemove
// ---------------------------------------------------------------------------

export async function repoRemove(repoRoot: string, name: string): Promise<void> {
  const config = await loadConfig(repoRoot);

  if (config.store === "pg") {
    const repos = (await pgUnsafe(`SELECT id FROM repos WHERE name = $1`, [name])) as {
      id: string;
    }[];
    if (repos.length === 0) throw new Error(`Repo not found: ${name}`);
    const repoId = parseInt(repos[0].id);

    // Delete in order respecting foreign keys, pinned to a single connection
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
  } else {
    const db = await getSqlite(repoRoot);
    const repos = db.prepare(`SELECT id FROM repos WHERE name = ?`).all(name) as { id: number }[];
    if (repos.length === 0) throw new Error(`Repo not found: ${name}`);
    const repoId = repos[0].id;

    // Get IDs for vec0 virtual table cleanup
    const fileIds = (
      db.prepare(`SELECT id FROM files WHERE repo_id = ?`).all(repoId) as { id: number }[]
    ).map((r) => r.id);

    const dirIds = (
      db.prepare(`SELECT id FROM directories WHERE repo_id = ?`).all(repoId) as { id: number }[]
    ).map((r) => r.id);

    const commitIds = (
      db.prepare(`SELECT id FROM commits WHERE repo_id = ?`).all(repoId) as { id: number }[]
    ).map((r) => r.id);

    // Wrap all deletes in a transaction for atomicity
    const removeAll = db.transaction(() => {
      // Delete from vec0 virtual tables by primary key
      const deleteVec0 = db.prepare(`DELETE FROM file_embeddings WHERE file_id = ?`);
      for (const id of fileIds) deleteVec0.run(id);

      const deleteDirConcat = db.prepare(`DELETE FROM dir_concat_embeddings WHERE dir_id = ?`);
      const deleteDirSummary = db.prepare(`DELETE FROM dir_summary_embeddings WHERE dir_id = ?`);
      for (const id of dirIds) {
        deleteDirConcat.run(id);
        deleteDirSummary.run(id);
      }

      const deleteCommitEmb = db.prepare(`DELETE FROM commit_embeddings WHERE commit_id = ?`);
      for (const id of commitIds) deleteCommitEmb.run(id);

      // Delete from regular tables
      db.prepare(`DELETE FROM cost_events WHERE repo_id = ?`).run(repoId);
      db.prepare(
        `DELETE FROM file_commits WHERE file_id IN (SELECT id FROM files WHERE repo_id = ?)`,
      ).run(repoId);
      db.prepare(`DELETE FROM files WHERE repo_id = ?`).run(repoId);
      db.prepare(`DELETE FROM directories WHERE repo_id = ?`).run(repoId);
      db.prepare(`DELETE FROM commits WHERE repo_id = ?`).run(repoId);
      db.prepare(`DELETE FROM repos WHERE id = ?`).run(repoId);
    });
    removeAll();
  }

  console.log(`Removed repo: ${name}`);
}

// ---------------------------------------------------------------------------
// repoGetAll — return all registered repos as data
// ---------------------------------------------------------------------------

export async function repoGetAll(repoRoot: string): Promise<{ name: string; root_path: string }[]> {
  const config = await loadConfig(repoRoot);

  if (config.store === "pg") {
    const rows = (await pgUnsafe(`SELECT name, root_path FROM repos ORDER BY id`)) as {
      name: string;
      root_path: string;
    }[];
    return rows;
  } else {
    const db = await getSqlite(repoRoot);
    return db.prepare(`SELECT name, root_path FROM repos ORDER BY id`).all() as {
      name: string;
      root_path: string;
    }[];
  }
}

// ---------------------------------------------------------------------------
// repoList
// ---------------------------------------------------------------------------

export async function repoList(repoRoot: string): Promise<void> {
  const config = await loadConfig(repoRoot);

  if (config.store === "pg") {
    const rows = (await pgUnsafe(
      `SELECT r.id, r.name, r.root_path,
              COUNT(f.id)::text AS file_count,
              MAX(f.indexed_at)::text AS last_indexed
       FROM repos r
       LEFT JOIN files f ON f.repo_id = r.id
       GROUP BY r.id, r.name, r.root_path
       ORDER BY r.id`,
    )) as PgListRow[];

    printRepoTable(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        root_path: r.root_path,
        file_count: r.file_count,
        last_indexed: r.last_indexed ?? "-",
      })),
    );
  } else {
    const db = await getSqlite(repoRoot);
    const rows = db
      .prepare(
        `SELECT r.id, r.name, r.root_path,
                COUNT(f.id) AS file_count,
                MAX(f.indexed_at) AS last_indexed
         FROM repos r
         LEFT JOIN files f ON f.repo_id = r.id
         GROUP BY r.id, r.name, r.root_path
         ORDER BY r.id`,
      )
      .all() as SqliteListRow[];

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
}

function printRepoTable(
  rows: { id: string; name: string; root_path: string; file_count: string; last_indexed: string }[],
): void {
  const header = `${"ID".padEnd(4)}${"Name".padEnd(18)}${"Path".padEnd(30)}${"Files".padEnd(7)}Last Indexed`;
  console.log(header);
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(4)}${r.name.padEnd(18)}${r.root_path.padEnd(30)}${r.file_count.padEnd(7)}${r.last_indexed}`,
    );
  }
}

// ---------------------------------------------------------------------------
// repoStatus
// ---------------------------------------------------------------------------

export async function repoStatus(repoRoot: string, name?: string): Promise<void> {
  const config = await loadConfig(repoRoot);

  if (config.store === "pg") {
    let repo: PgRepoRow;
    if (name) {
      const rows = (await pgUnsafe(
        `SELECT id, origin_url, root_path, name, formatter_cmd FROM repos WHERE name = $1`,
        [name],
      )) as PgRepoRow[];
      if (rows.length === 0) throw new Error(`Repo not found: ${name}`);
      repo = rows[0];
    } else {
      const rows = (await pgUnsafe(
        `SELECT id, origin_url, root_path, name, formatter_cmd FROM repos WHERE root_path = $1`,
        [repoRoot],
      )) as PgRepoRow[];
      if (rows.length === 0) throw new Error(`Repo not found for path: ${repoRoot}`);
      repo = rows[0];
    }

    const repoId = parseInt(repo.id);
    const fileCount = (
      (await pgUnsafe(`SELECT COUNT(*)::text AS count FROM files WHERE repo_id = $1`, [
        repoId,
      ])) as CountRow[]
    )[0].count;
    const dirCount = (
      (await pgUnsafe(`SELECT COUNT(*)::text AS count FROM directories WHERE repo_id = $1`, [
        repoId,
      ])) as CountRow[]
    )[0].count;
    const commitCount = (
      (await pgUnsafe(`SELECT COUNT(*)::text AS count FROM commits WHERE repo_id = $1`, [
        repoId,
      ])) as CountRow[]
    )[0].count;
    const lastIndexed = (
      (await pgUnsafe(`SELECT MAX(indexed_at)::text AS count FROM files WHERE repo_id = $1`, [
        repoId,
      ])) as CountRow[]
    )[0].count;

    printStatus(
      repo.name,
      repo.root_path,
      repo.origin_url,
      config.store,
      repo.formatter_cmd,
      String(fileCount),
      String(dirCount),
      String(commitCount),
      lastIndexed != null ? String(lastIndexed) : "-",
    );
  } else {
    const db = await getSqlite(repoRoot);
    let repo: SqliteRepoRow;
    if (name) {
      const rows = db
        .prepare(`SELECT id, origin_url, root_path, name, formatter_cmd FROM repos WHERE name = ?`)
        .all(name) as SqliteRepoRow[];
      if (rows.length === 0) throw new Error(`Repo not found: ${name}`);
      repo = rows[0];
    } else {
      const rows = db
        .prepare(
          `SELECT id, origin_url, root_path, name, formatter_cmd FROM repos WHERE root_path = ?`,
        )
        .all(repoRoot) as SqliteRepoRow[];
      if (rows.length === 0) throw new Error(`Repo not found for path: ${repoRoot}`);
      repo = rows[0];
    }

    const repoId = repo.id;
    const fileCount = (
      db.prepare(`SELECT COUNT(*) AS count FROM files WHERE repo_id = ?`).all(repoId) as CountRow[]
    )[0].count;
    const dirCount = (
      db
        .prepare(`SELECT COUNT(*) AS count FROM directories WHERE repo_id = ?`)
        .all(repoId) as CountRow[]
    )[0].count;
    const commitCount = (
      db
        .prepare(`SELECT COUNT(*) AS count FROM commits WHERE repo_id = ?`)
        .all(repoId) as CountRow[]
    )[0].count;
    const lastIndexed = (
      db
        .prepare(`SELECT MAX(indexed_at) AS count FROM files WHERE repo_id = ?`)
        .all(repoId) as CountRow[]
    )[0].count;

    printStatus(
      repo.name,
      repo.root_path,
      repo.origin_url,
      config.store,
      repo.formatter_cmd,
      String(fileCount),
      String(dirCount),
      String(commitCount),
      lastIndexed != null ? String(lastIndexed) : "-",
    );
  }
}

function printStatus(
  name: string,
  rootPath: string,
  originUrl: string | null,
  store: string,
  formatter: string | null,
  fileCount: string,
  dirCount: string,
  commitCount: string,
  lastIndexed: string,
): void {
  console.log(`Name:         ${name}`);
  console.log(`Path:         ${rootPath}`);
  console.log(`Origin:       ${originUrl ?? "-"}`);
  console.log(`Store:        ${store}`);
  console.log(`Files:        ${fileCount}`);
  console.log(`Directories:  ${dirCount}`);
  console.log(`Commits:      ${commitCount}`);
  console.log(`Last Indexed: ${lastIndexed}`);
  console.log(`Formatter:    ${formatter ?? "-"}`);
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
