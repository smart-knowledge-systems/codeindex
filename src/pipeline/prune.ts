import { getPg, pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import type { PipelineContext, PruneStage } from "./types";

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
  let pruned = 0;

  if (store === "pg") {
    const rows = (await pgUnsafe("SELECT file_path FROM files WHERE repo_id = $1", [repoId])) as {
      file_path: string;
    }[];
    const stalePaths = rows.filter((r) => !currentFiles.has(r.file_path)).map((r) => r.file_path);

    if (stalePaths.length > 0) {
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
      pruned = stalePaths.length;
    }
  } else {
    const db = await getSqlite(repoRoot);
    const rows = db.prepare("SELECT file_path FROM files WHERE repo_id = ?").all(repoId) as {
      file_path: string;
    }[];
    const stalePaths = rows.filter((r) => !currentFiles.has(r.file_path)).map((r) => r.file_path);

    if (stalePaths.length > 0) {
      const selectId = db.prepare("SELECT id FROM files WHERE repo_id = ? AND file_path = ?");
      const delImports = db.prepare("DELETE FROM file_imports WHERE source_file_id = ?");
      const delEmbeddings = db.prepare("DELETE FROM file_embeddings WHERE file_id = ?");
      const delCommits = db.prepare("DELETE FROM file_commits WHERE file_id = ?");
      const delFile = db.prepare("DELETE FROM files WHERE id = ?");

      db.transaction(() => {
        for (const fp of stalePaths) {
          const fileRows = selectId.all(repoId, fp) as { id: number }[];
          if (fileRows.length > 0) {
            const fileId = fileRows[0].id;
            delImports.run(fileId);
            delEmbeddings.run(fileId);
            delCommits.run(fileId);
            delFile.run(fileId);
          }
        }
      })();
      pruned = stalePaths.length;
    }
  }

  return pruned;
};
