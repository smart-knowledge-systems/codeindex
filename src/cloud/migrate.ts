// Cloud migrate command

import { hasFlag, type ParsedArgs } from "../cli";
import { getSqlite } from "../db/sqlite";
import { CloudClient } from "./client";
import { formatError } from "../errors";

const BATCH_SIZE = 50;

interface LocalFileRow {
  rel_path: string;
  content_hash: string;
  file_type: string;
  skeleton: string | null;
  skeleton_entries: string | null;
}

export async function cloudMigrate(repoRoot: string, parsed: ParsedArgs): Promise<void> {
  const client = new CloudClient();
  await client.loadCredentials();

  if (!client.isAuthenticated()) {
    process.stderr.write("Not logged in. Run `cidx cloud login` to authenticate.\n");
    process.exit(1);
  }

  const dryRun = hasFlag(parsed, "dry-run");

  // Read local files from SQLite
  process.stderr.write("Reading local index...\n");
  let db;
  try {
    db = await getSqlite(repoRoot);
  } catch (err) {
    process.stderr.write(`Could not open local database: ${formatError(err)}\n`);
    process.exit(1);
  }

  const rows = db
    .prepare(
      "SELECT file_path AS rel_path, content_hash, file_type, skeleton, skeleton_entries FROM files",
    )
    .all() as LocalFileRow[];

  if (rows.length === 0) {
    process.stderr.write("No files in local index. Run `cidx reindex` first.\n");
    return;
  }

  // Check embedding dimensions — warn on mismatch
  const embRow = db
    .prepare("SELECT embedding FROM files WHERE embedding IS NOT NULL LIMIT 1")
    .get() as { embedding: Uint8Array | null } | null;

  if (embRow?.embedding) {
    // sqlite-vec stores embeddings as raw float32 blobs
    const dimBytes = embRow.embedding.byteLength;
    const dim = dimBytes / 4; // float32 = 4 bytes
    if (dim === 768) {
      process.stderr.write(
        "Warning: Local embeddings are 768-dimensional (Ollama). Cloud uses 1536-dimensional (OpenAI).\n" +
          "Embeddings will be re-generated on the cloud side.\n",
      );
    }
  }

  process.stderr.write(`Found ${rows.length} files in local index\n`);

  if (dryRun) {
    process.stderr.write("Dry run — nothing sent to cloud.\n");
    for (const r of rows) {
      process.stderr.write(`  ${r.rel_path} (${r.file_type})\n`);
    }
    process.stderr.write(`Total: ${rows.length} files would be migrated\n`);
    return;
  }

  // Batch upload — privacy: only send rel_path, content_hash, file_type, size
  let totalImported = 0;
  let totalSkipped = 0;

  try {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const payload = batch.map((r) => ({
        contentHash: r.content_hash,
        path: r.rel_path,
        language: r.file_type,
        sizeBytes: r.skeleton ? new TextEncoder().encode(r.skeleton).length : 0,
      }));

      const result = await client.migrate({ files: payload });
      totalImported += result.imported;
      totalSkipped += result.skipped;

      process.stderr.write(
        `  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${result.imported} imported, ${result.skipped} skipped\n`,
      );
    }

    process.stderr.write(
      `Migration complete: ${totalImported} imported, ${totalSkipped} skipped (${rows.length} total)\n`,
    );
  } catch (err) {
    process.stderr.write(`Cloud migration failed: ${formatError(err)}\n`);
    process.exit(1);
  }
}
