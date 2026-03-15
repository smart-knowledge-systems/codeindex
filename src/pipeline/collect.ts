import path from "path";
import { walkRepo, MAX_FILE_SIZE } from "../index/walker";
import { extractSkeletonWithEntries } from "../index/skeleton";
import { formatAndHash } from "../index/formatter";
import { scanForSecrets } from "../index/secrets";
import { extractImports } from "../index/imports";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import type { PipelineContext, CollectedFile, CollectStage } from "./types";

/**
 * Walk the repo, read each file, scan for secrets, compute content hash,
 * check dedup (skip if hash matches DB), extract skeleton and imports.
 * Returns files that need re-embedding.
 */
export const collectFiles: CollectStage = async (
  ctx: PipelineContext,
): Promise<CollectedFile[]> => {
  const { repoRoot, repoId, config, formatter, store, force } = ctx;

  // Load existing content hashes from DB for dedup (unless force)
  const existingHashes = new Map<string, string>(); // relPath → contentHash
  if (!force) {
    if (store === "pg") {
      const rows = (await pgUnsafe("SELECT file_path, content_hash FROM files WHERE repo_id = $1", [
        repoId,
      ])) as { file_path: string; content_hash: string }[];
      for (const r of rows) existingHashes.set(r.file_path, r.content_hash);
    } else {
      const db = await getSqlite(repoRoot);
      const rows = db
        .prepare("SELECT file_path, content_hash FROM files WHERE repo_id = ?")
        .all(repoId) as { file_path: string; content_hash: string }[];
      for (const r of rows) existingHashes.set(r.file_path, r.content_hash);
    }
  }

  const collected: CollectedFile[] = [];

  for await (const relPath of walkRepo(repoRoot)) {
    const absPath = path.join(repoRoot, relPath);
    const file = Bun.file(absPath);

    if (file.size > MAX_FILE_SIZE) continue;

    const raw = await file.text();
    const content = raw.replace(/\0/g, "");

    const scan = scanForSecrets(content);
    if (scan.hasSecrets) {
      console.warn(`  SKIP ${relPath}: potential secrets (${scan.patterns.join(", ")})`);
      continue;
    }

    const ext = path.extname(relPath).toLowerCase() || ".txt";
    const { hash } = await formatAndHash(content, formatter);

    // Skip if hash matches existing DB record (dedup)
    if (!force && existingHashes.get(relPath) === hash) continue;

    const { text: skeleton, entries } = await extractSkeletonWithEntries(
      relPath,
      content,
      config.skeletonFallbackLines,
    );
    const skeletonEntries = entries.length > 0 ? JSON.stringify(entries) : null;
    const importEdges = extractImports(relPath, content);

    collected.push({
      relPath,
      absPath,
      fileType: ext,
      contentHash: hash,
      content,
      skeleton,
      skeletonEntries,
      importEdges,
    });
  }

  return collected;
};
