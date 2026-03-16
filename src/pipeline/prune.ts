import type { Database } from "bun:sqlite";
import { getPg, pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { logEvent } from "../logging";
import type { PipelineContext, PruneStage } from "./types";

/**
 * Pure function: determine which file paths are stale (exist in DB but
 * not in the current file set).
 */
function findStalePaths(
  existingPaths: readonly { file_path: string }[],
  currentFiles: Set<string>,
): string[] {
  return existingPaths.filter((r) => !currentFiles.has(r.file_path)).map((r) => r.file_path);
}

/**
 * Delete stale files from PostgreSQL within a transaction.
 */
async function prunePg(repoId: number, stalePaths: string[]): Promise<void> {
  const pg = await getPg();
  await pg.begin(async (tx) => {
    for (const fp of stalePaths) {
      await tx.unsafe(
        "DELETE FROM file_imports WHERE source_file_id IN (SELECT id FROM files WHERE repo_id = $1 AND file_path = $2)",
        [repoId, fp],
      );
      await tx.unsafe(
        "DELETE FROM file_commits WHERE file_id IN (SELECT id FROM files WHERE repo_id = $1 AND file_path = $2)",
        [repoId, fp],
      );
      await tx.unsafe("DELETE FROM files WHERE repo_id = $1 AND file_path = $2", [repoId, fp]);
    }
  });
}

/**
 * Delete stale files from SQLite within a transaction.
 */
function pruneSqlite(db: Database, repoId: number, stalePaths: string[]): void {
  const selectId = db.prepare("SELECT id FROM files WHERE repo_id = ? AND file_path = ?");
  const delImports = db.prepare("DELETE FROM file_imports WHERE source_file_id = ?");
  const delEmbeddings = db.prepare("DELETE FROM file_embeddings WHERE file_id = ?");
  const delCommits = db.prepare("DELETE FROM file_commits WHERE file_id = ?");
  const delFile = db.prepare("DELETE FROM files WHERE id = ?");

  db.transaction(() => {
    for (const fp of stalePaths) {
      const fileRow = (selectId.all(repoId, fp) as { id: number }[]).at(0);
      if (fileRow) {
        const fileId = fileRow.id;
        delImports.run(fileId);
        delEmbeddings.run(fileId);
        delCommits.run(fileId);
        delFile.run(fileId);
      }
    }
  })();
}

/**
 * Remove DB rows for files that are no longer present in the repo.
 * Compares the provided set of current file paths against the DB.
 * Returns the count of pruned file rows.
 */
export const pruneStale: PruneStage = async (
  ctx: PipelineContext,
  currentFiles: Set<string>,
): Promise<number> => {
  const { repoRoot, repoId, store } = ctx;
  const start = performance.now();

  // Fetch existing file paths from the store
  const existingPaths =
    store === "pg"
      ? ((await pgUnsafe("SELECT file_path FROM files WHERE repo_id = $1", [repoId])) as {
          file_path: string;
        }[])
      : ((await getSqlite(repoRoot))
          .prepare("SELECT file_path FROM files WHERE repo_id = ?")
          .all(repoId) as { file_path: string }[]);

  // Pure: determine which paths are stale
  const stalePaths = findStalePaths(existingPaths, currentFiles);

  if (stalePaths.length > 0) {
    if (store === "pg") {
      await prunePg(repoId, stalePaths);
    } else {
      const db = await getSqlite(repoRoot);
      pruneSqlite(db, repoId, stalePaths);
    }
  }

  logEvent({
    event: "infra.prune.complete",
    pruned_count: stalePaths.length,
    duration_ms: Math.round(performance.now() - start),
  });

  return stalePaths.length;
};
