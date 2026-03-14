import path from "path";
import { loadConfig, detectFormatter } from "../config";
import { getPg, pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { serializeEmbedding } from "../db/util";
import { extractSkeletonWithEntries, initParser } from "./skeleton";
import { formatAndHash } from "./formatter";
import { scanForSecrets } from "./secrets";
import { embed } from "./embedder";
import { updateAffectedDirectories } from "./directories";

/**
 * Reindex a single file: extract skeleton, embed, and upsert into the DB.
 * Returns true if the file was indexed, false if skipped (unchanged or secret).
 */
export async function reindexSingleFile(
  repoRoot: string,
  repoId: number,
  relPath: string,
): Promise<boolean> {
  const config = await loadConfig(repoRoot);
  const formatter = config.formatter ?? (await detectFormatter(repoRoot));

  const absPath = path.join(repoRoot, relPath);
  const file = Bun.file(absPath);
  if (!(await file.exists())) {
    // File was deleted — remove from index
    if (config.store === "pg") {
      const pg = await getPg();
      await pg.begin(async (tx) => {
        const rows = (await tx.unsafe(
          "SELECT id FROM files WHERE repo_id = $1 AND file_path = $2",
          [repoId, relPath],
        )) as { id: number }[];
        if (rows.length > 0) {
          await tx.unsafe("DELETE FROM file_commits WHERE file_id = $1", [rows[0].id]);
          await tx.unsafe("DELETE FROM file_imports WHERE source_file_id = $1", [rows[0].id]);
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
          db.prepare("DELETE FROM files WHERE id = ?").run(rows[0].id);
        })();
      }
    }
    return true;
  }

  const content = (await file.text()).replace(/\0/g, "");

  const scan = scanForSecrets(content);
  if (scan.hasSecrets) {
    return false;
  }

  const ext = path.extname(relPath).toLowerCase() || ".txt";
  const { hash } = await formatAndHash(content, formatter);

  // Check if already indexed with same hash
  if (config.store === "pg") {
    const existing = await pgUnsafe(
      "SELECT id FROM files WHERE repo_id = $1 AND file_path = $2 AND content_hash = $3",
      [repoId, relPath, hash],
    );
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

  const [embedding] = await embed([skeleton]);

  if (config.store === "pg") {
    await pgUnsafe(
      `INSERT INTO files (repo_id, file_path, content_hash, skeleton, skeleton_entries, file_type, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
       ON CONFLICT (repo_id, file_path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         skeleton = EXCLUDED.skeleton,
         skeleton_entries = EXCLUDED.skeleton_entries,
         file_type = EXCLUDED.file_type,
         embedding = EXCLUDED.embedding,
         indexed_at = now()`,
      [repoId, relPath, hash, skeleton, skeletonEntries, ext, `[${embedding.join(",")}]`],
    );
  } else {
    const db = await getSqlite(repoRoot);
    const row = db
      .prepare(
        `INSERT INTO files (repo_id, file_path, content_hash, skeleton, skeleton_entries, file_type)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, file_path) DO UPDATE SET
           content_hash = excluded.content_hash,
           skeleton = excluded.skeleton,
           skeleton_entries = excluded.skeleton_entries,
           file_type = excluded.file_type,
           indexed_at = datetime('now')
         RETURNING id`,
      )
      .get(repoId, relPath, hash, skeleton, skeletonEntries, ext) as { id: number };
    db.prepare("DELETE FROM file_embeddings WHERE file_id = ?").run(row.id);
    db.prepare("INSERT INTO file_embeddings (file_id, embedding) VALUES (?, ?)").run(
      row.id,
      serializeEmbedding(embedding),
    );
  }

  // Update affected directories
  await updateAffectedDirectories(repoRoot, repoId, [relPath]);

  return true;
}
