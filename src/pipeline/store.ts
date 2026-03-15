import { getPg } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { serializeEmbedding } from "../db/util";
import { resolveImport } from "../index/imports";
import type { PipelineContext, EmbeddedFile, StoreFilesStage } from "./types";

/**
 * Pure: resolve import edges for a file against a known set of all file paths.
 * Returns an array of { importedModule, resolvedFilePath, language } records.
 */
function resolveFileImports(
  file: EmbeddedFile,
  allFiles: Set<string>,
  fileIdMap: ReadonlyMap<string, number>,
): Array<{ importedModule: string; resolvedId: number | null; language: string }> {
  return file.importEdges.map((edge) => {
    const resolved = resolveImport(edge.importedModule, file.relPath, edge.language, allFiles);
    const resolvedId = resolved ? (fileIdMap.get(resolved) ?? null) : null;
    return { importedModule: edge.importedModule, resolvedId, language: edge.language };
  });
}

/**
 * Upsert embedded files into the DB (files + embeddings + import edges).
 * Builds a FileIndex internally for import resolution.
 * Transaction-wrapped for atomicity.
 */
export const storeFiles: StoreFilesStage = async (
  ctx: PipelineContext,
  files: EmbeddedFile[],
): Promise<void> => {
  if (files.length === 0) return;

  const { repoRoot, repoId, store } = ctx;

  if (store === "pg") {
    const pg = await getPg();
    await pg.begin(async (tx) => {
      // Upsert all files, collecting id→path mappings
      const upsertedEntries = await Promise.all(
        files.map(async (f) => {
          const rows = (await tx.unsafe(
            `INSERT INTO files (repo_id, file_path, content_hash, skeleton, skeleton_entries, file_type, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
             ON CONFLICT (repo_id, file_path) DO UPDATE SET
               content_hash = EXCLUDED.content_hash,
               skeleton = EXCLUDED.skeleton,
               skeleton_entries = EXCLUDED.skeleton_entries,
               file_type = EXCLUDED.file_type,
               embedding = EXCLUDED.embedding,
               indexed_at = now()
             RETURNING id`,
            [
              repoId,
              f.relPath,
              f.contentHash,
              f.skeleton,
              f.skeletonEntries,
              f.fileType,
              `[${f.embedding.join(",")}]`,
            ],
          )) as { id: number }[];
          const upserted = rows.find(() => true);
          return upserted ? ([f.relPath, upserted.id] as const) : null;
        }),
      );

      const fileIdMap = new Map<string, number>(
        upsertedEntries.filter((e): e is NonNullable<typeof e> => e != null),
      );

      // Load existing files not in this batch for import resolution
      const existingRows = (await tx.unsafe("SELECT id, file_path FROM files WHERE repo_id = $1", [
        repoId,
      ])) as { id: number; file_path: string }[];
      const allFiles = new Set<string>();
      for (const r of existingRows) {
        allFiles.add(r.file_path);
        if (!fileIdMap.has(r.file_path)) fileIdMap.set(r.file_path, r.id);
      }

      // Refresh import edges for each stored file
      for (const f of files) {
        const fileId = fileIdMap.get(f.relPath);
        if (fileId == null) continue;
        await tx.unsafe("DELETE FROM file_imports WHERE source_file_id = $1", [fileId]);
        const imports = resolveFileImports(f, allFiles, fileIdMap);
        for (const imp of imports) {
          await tx.unsafe(
            `INSERT INTO file_imports (source_file_id, imported_module, resolved_file_id, language)
             VALUES ($1, $2, $3, $4)`,
            [fileId, imp.importedModule, imp.resolvedId, imp.language],
          );
        }
      }
    });
  } else {
    const db = await getSqlite(repoRoot);

    const insertFile = db.prepare(
      `INSERT INTO files (repo_id, file_path, content_hash, skeleton, skeleton_entries, file_type)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, file_path) DO UPDATE SET
         content_hash = excluded.content_hash,
         skeleton = excluded.skeleton,
         skeleton_entries = excluded.skeleton_entries,
         file_type = excluded.file_type,
         indexed_at = datetime('now')
       RETURNING id`,
    );
    const deleteEmb = db.prepare(`DELETE FROM file_embeddings WHERE file_id = ?`);
    const insertEmb = db.prepare(`INSERT INTO file_embeddings (file_id, embedding) VALUES (?, ?)`);
    const deleteImports = db.prepare(`DELETE FROM file_imports WHERE source_file_id = ?`);
    const insertImport = db.prepare(
      `INSERT INTO file_imports (source_file_id, imported_module, resolved_file_id, language)
       VALUES (?, ?, ?, ?)`,
    );

    db.transaction(() => {
      // Build file ID map from existing rows
      const existingRows = db
        .prepare("SELECT id, file_path FROM files WHERE repo_id = ?")
        .all(repoId) as { id: number; file_path: string }[];
      const allFiles = new Set<string>(existingRows.map((r) => r.file_path));
      const fileIdMap = new Map<string, number>(existingRows.map((r) => [r.file_path, r.id]));

      // Add files being stored to the set (they may be new)
      for (const f of files) {
        allFiles.add(f.relPath);
      }

      for (const f of files) {
        const row = insertFile.get(
          repoId,
          f.relPath,
          f.contentHash,
          f.skeleton,
          f.skeletonEntries,
          f.fileType,
        ) as { id: number };

        deleteEmb.run(row.id);
        insertEmb.run(row.id, serializeEmbedding(f.embedding));
        fileIdMap.set(f.relPath, row.id);

        deleteImports.run(row.id);
        const imports = resolveFileImports(f, allFiles, fileIdMap);
        for (const imp of imports) {
          insertImport.run(row.id, imp.importedModule, imp.resolvedId, imp.language);
        }
      }
    })();
  }
};
