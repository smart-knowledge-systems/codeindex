import { getPg } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { serializeEmbedding } from "../db/util";
import { resolveImport } from "../index/imports";
import { logEvent } from "../logging";
import type { PipelineContext, EmbeddedFile, StoreFilesStage } from "./types";
import type { GlobalDedupStore } from "../dedup/global-store";

/**
 * Push freshly-embedded files into the global dedup store. Files that came
 * out of the embed stage with a cachedEmbedding are skipped — they were
 * already in the store. Failures are logged but never abort the per-repo
 * write path; the global store is a cache, not a source of truth for search.
 */
async function writeFreshBlobsToGlobalStore(
  globalStore: GlobalDedupStore,
  ctx: PipelineContext,
  files: EmbeddedFile[],
): Promise<void> {
  const { provider, model, dimensions } = ctx.config.embedding;
  for (const f of files) {
    if (f.cachedEmbedding && f.cachedEmbedding.length > 0) continue;
    try {
      await globalStore.writeBlob(
        { contentHash: f.contentHash, provider, model, dimensions },
        {
          skeleton: f.skeleton,
          skeletonEntries: f.skeletonEntries,
          embedding: f.embedding,
        },
      );
    } catch (err) {
      logEvent({
        event: "infra.dedup.write_failed",
        content_hash: f.contentHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

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
  const { provider, model, dimensions } = ctx.config.embedding;

  // Write freshly-embedded files (cache misses) back to the global store so
  // future reindexes — local OR cross-repo — can reuse them. Best-effort:
  // global-store failures log and continue; per-repo writes are the contract.
  if (ctx.globalStore) {
    await writeFreshBlobsToGlobalStore(ctx.globalStore, ctx, files);
  }

  if (store === "pg") {
    const pg = await getPg();
    await pg.begin(async (tx) => {
      // Upsert all files sequentially (single tx connection), collecting id→path mappings
      const fileIdMap = new Map<string, number>();
      for (const f of files) {
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
        const upserted = rows.at(0);
        if (upserted) fileIdMap.set(f.relPath, upserted.id);

        // Phase 3 dual-write: best-effort populate file_blobs + repo_files.
        // Failures here log and continue — the legacy files row above is the
        // source of truth until commit 9 flips useBlobSchema to true.
        try {
          await tx.unsafe(
            `INSERT INTO file_blobs
               (content_hash, provider, model, dimensions, skeleton, skeleton_entries, file_type, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)
             ON CONFLICT (content_hash, provider, model, dimensions) DO NOTHING`,
            [
              f.contentHash,
              provider,
              model,
              dimensions,
              f.skeleton,
              f.skeletonEntries,
              f.fileType,
              `[${f.embedding.join(",")}]`,
            ],
          );
          await tx.unsafe(
            `INSERT INTO repo_files
               (repo_id, file_path, content_hash, provider, model, dimensions)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (repo_id, file_path) DO UPDATE SET
               content_hash = EXCLUDED.content_hash,
               provider = EXCLUDED.provider,
               model = EXCLUDED.model,
               dimensions = EXCLUDED.dimensions,
               indexed_at = now()`,
            [repoId, f.relPath, f.contentHash, provider, model, dimensions],
          );
        } catch (err) {
          logEvent({
            event: "infra.dedup.dualwrite_failed",
            backend: "pg",
            content_hash: f.contentHash,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

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
    const insertBlob = db.prepare(
      `INSERT INTO file_blobs
         (content_hash, provider, model, dimensions, skeleton, skeleton_entries, file_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_hash, provider, model, dimensions) DO NOTHING`,
    );
    const upsertRepoFile = db.prepare(
      `INSERT INTO repo_files
         (repo_id, file_path, content_hash, provider, model, dimensions)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, file_path) DO UPDATE SET
         content_hash = excluded.content_hash,
         provider = excluded.provider,
         model = excluded.model,
         dimensions = excluded.dimensions,
         indexed_at = datetime('now')`,
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

        // Phase 3 dual-write (SQLite): scalar tables only — vec0 virtual
        // table for blobs lands in a later commit. Best-effort: failures log
        // and continue.
        try {
          insertBlob.run(
            f.contentHash,
            provider,
            model,
            dimensions,
            f.skeleton,
            f.skeletonEntries,
            f.fileType,
          );
          upsertRepoFile.run(repoId, f.relPath, f.contentHash, provider, model, dimensions);
        } catch (err) {
          logEvent({
            event: "infra.dedup.dualwrite_failed",
            backend: "sqlite",
            content_hash: f.contentHash,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        deleteImports.run(row.id);
        const imports = resolveFileImports(f, allFiles, fileIdMap);
        for (const imp of imports) {
          insertImport.run(row.id, imp.importedModule, imp.resolvedId, imp.language);
        }
      }
    })();
  }
};
