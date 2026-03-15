import path from "path";
import { loadConfig, detectFormatter } from "../config";
import { withRepoScope } from "../db/rls";
import { getSqlite } from "../db/sqlite";
import { extractSkeletonWithEntries, initParser } from "./skeleton";
import { formatAndHash } from "./formatter";
import { scanForSecrets } from "./secrets";
import { updateAffectedDirectories } from "./directories";
import { extractImports } from "./imports";
import { MAX_FILE_SIZE } from "./walker";
import { embedFiles, storeFiles } from "../pipeline";
import type { PipelineContext, CollectedFile } from "../pipeline";

/** Pre-built file index for import resolution, reusable across batch calls. */
export interface FileIndex {
  allFiles: Set<string>;
  fileIdMap: Map<string, number>;
}

/** Load the file index for a repo. Call once and pass to reindexSingleFile in a batch. */
export async function loadFileIndex(repoRoot: string, repoId: number): Promise<FileIndex> {
  const config = await loadConfig(repoRoot);
  if (config.store === "pg") {
    return withRepoScope([repoId], async (tx) => {
      const rows = (await tx.unsafe("SELECT id, file_path FROM files WHERE repo_id = $1", [
        repoId,
      ])) as { id: number; file_path: string }[];
      return {
        allFiles: new Set(rows.map((r) => r.file_path)),
        fileIdMap: new Map(rows.map((r) => [r.file_path, r.id])),
      };
    });
  } else {
    const db = await getSqlite(repoRoot);
    const rows = db.prepare("SELECT id, file_path FROM files WHERE repo_id = ?").all(repoId) as {
      id: number;
      file_path: string;
    }[];
    return {
      allFiles: new Set(rows.map((r) => r.file_path)),
      fileIdMap: new Map(rows.map((r) => [r.file_path, r.id])),
    };
  }
}

/**
 * Reindex a single file: extract skeleton, embed, and upsert into the DB.
 * Returns true if the file was indexed, false if skipped (unchanged or secret).
 * Pass a pre-built fileIndex to avoid loading the full file list on each call.
 */
export async function reindexSingleFile(
  repoRoot: string,
  repoId: number,
  relPath: string,
  fileIndex?: FileIndex,
): Promise<boolean> {
  const config = await loadConfig(repoRoot);
  const formatter = config.formatter ?? (await detectFormatter(repoRoot));

  const absPath = path.join(repoRoot, relPath);
  const file = Bun.file(absPath);
  if (!(await file.exists())) {
    // File was deleted — remove from index
    if (config.store === "pg") {
      await withRepoScope([repoId], async (tx) => {
        const rows = (await tx.unsafe(
          "SELECT id FROM files WHERE repo_id = $1 AND file_path = $2",
          [repoId, relPath],
        )) as { id: number }[];
        if (rows.length > 0) {
          await tx.unsafe("DELETE FROM file_commits WHERE file_id = $1", [rows[0].id]);
          await tx.unsafe("DELETE FROM file_imports WHERE source_file_id = $1", [rows[0].id]);
          await tx.unsafe(
            "UPDATE file_imports SET resolved_file_id = NULL WHERE resolved_file_id = $1",
            [rows[0].id],
          );
          await tx.unsafe("DELETE FROM files WHERE id = $1", [rows[0].id]);
        }
      });
    } else {
      const db = await getSqlite(repoRoot);
      const rows = db
        .prepare("SELECT id FROM files WHERE repo_id = ? AND file_path = ?")
        .all(repoId, relPath) as { id: number }[];
      if (rows.length > 0) {
        db.transaction(() => {
          db.prepare("DELETE FROM file_embeddings WHERE file_id = ?").run(rows[0].id);
          db.prepare("DELETE FROM file_commits WHERE file_id = ?").run(rows[0].id);
          db.prepare("DELETE FROM file_imports WHERE source_file_id = ?").run(rows[0].id);
          db.prepare(
            "UPDATE file_imports SET resolved_file_id = NULL WHERE resolved_file_id = ?",
          ).run(rows[0].id);
          db.prepare("DELETE FROM files WHERE id = ?").run(rows[0].id);
        })();
      }
    }
    return true;
  }

  if (file.size > MAX_FILE_SIZE) return false;

  const content = (await file.text()).replace(/\0/g, "");

  const scan = scanForSecrets(content);
  if (scan.hasSecrets) {
    return false;
  }

  const ext = path.extname(relPath).toLowerCase() || ".txt";
  const { hash } = await formatAndHash(content, formatter);

  // Check if already indexed with same hash
  if (config.store === "pg") {
    const existing = await withRepoScope([repoId], async (tx) => {
      return await tx.unsafe(
        "SELECT id FROM files WHERE repo_id = $1 AND file_path = $2 AND content_hash = $3",
        [repoId, relPath, hash],
      );
    });
    if (existing.length > 0) return false;
  } else {
    const db = await getSqlite(repoRoot);
    const existing = db
      .prepare("SELECT id FROM files WHERE repo_id = ? AND file_path = ? AND content_hash = ?")
      .all(repoId, relPath, hash) as { id: number }[];
    if (existing.length > 0) return false;
  }

  await initParser();

  const { text: skeleton, entries } = await extractSkeletonWithEntries(
    relPath,
    content,
    config.skeletonFallbackLines,
  );
  const skeletonEntries = entries.length > 0 ? JSON.stringify(entries) : null;
  const importEdges = extractImports(relPath, content);

  const collected: CollectedFile = {
    relPath,
    absPath,
    fileType: ext,
    contentHash: hash,
    content,
    skeleton,
    skeletonEntries,
    importEdges,
  };

  const ctx: PipelineContext = {
    repoRoot,
    repoId,
    config,
    formatter,
    store: config.store,
    dryRun: false,
    force: false,
  };

  const embedded = await embedFiles(ctx, [collected]);
  if (embedded.length === 0) return false; // cost cap exceeded

  await storeFiles(ctx, embedded);

  // Update affected directories
  await updateAffectedDirectories(repoRoot, repoId, [relPath]);

  // Suppress unused parameter warning — fileIndex kept for API compatibility
  void fileIndex;

  return true;
}
