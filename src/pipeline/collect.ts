import path from "path";
import { walkRepo, MAX_FILE_SIZE } from "../index/walker";
import { extractSkeletonWithEntries } from "../index/skeleton";
import { formatAndHash } from "../index/formatter";
import { scanForSecrets } from "../index/secrets";
import { extractImports } from "../index/imports";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { logEvent, hashPath } from "../logging";
import type { PipelineContext, CollectedFile, CollectStage } from "./types";

// ---------------------------------------------------------------------------
// Pure core — process a single file's data, no I/O
// ---------------------------------------------------------------------------

interface FileInput {
  relPath: string;
  absPath: string;
  content: string;
}

async function processFile(
  file: FileInput,
  existingHashes: Map<string, string>,
  force: boolean,
  skeletonFallbackLines: number,
  formatter: string | null,
): Promise<CollectedFile | null> {
  const scan = scanForSecrets(file.content);
  if (scan.hasSecrets) {
    process.stderr.write(`  SKIP ${file.relPath}: potential secrets detected\n`);
    logEvent({
      event: "infra.secrets.detected",
      file_path_hash: hashPath(file.relPath),
      patterns: scan.patterns,
    });
    return null;
  }

  const ext = path.extname(file.relPath).toLowerCase() || ".txt";
  const { hash } = await formatAndHash(file.content, formatter);

  // Skip if hash matches existing DB record (dedup)
  if (!force && existingHashes.get(file.relPath) === hash) return null;

  const { text: skeleton, entries } = await extractSkeletonWithEntries(
    file.relPath,
    file.content,
    skeletonFallbackLines,
  );
  const skeletonEntries = entries.length > 0 ? JSON.stringify(entries) : null;
  const importEdges = extractImports(file.relPath, file.content);

  return {
    relPath: file.relPath,
    absPath: file.absPath,
    fileType: ext,
    contentHash: hash,
    content: file.content,
    skeleton,
    skeletonEntries,
    importEdges,
  };
}

// ---------------------------------------------------------------------------
// Impure shell — I/O for loading hashes and reading files
// ---------------------------------------------------------------------------

async function loadExistingHashes(
  repoRoot: string,
  repoId: number,
  store: string,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  if (store === "pg") {
    const rows = (await pgUnsafe("SELECT file_path, content_hash FROM files WHERE repo_id = $1", [
      repoId,
    ])) as { file_path: string; content_hash: string }[];
    for (const r of rows) hashes.set(r.file_path, r.content_hash);
  } else {
    const db = await getSqlite(repoRoot);
    const rows = db
      .prepare("SELECT file_path, content_hash FROM files WHERE repo_id = ?")
      .all(repoId) as { file_path: string; content_hash: string }[];
    for (const r of rows) hashes.set(r.file_path, r.content_hash);
  }

  return hashes;
}

/**
 * Walk the repo, read each file, scan for secrets, compute content hash,
 * check dedup (skip if hash matches DB), extract skeleton and imports.
 * Returns files that need re-embedding.
 */
export const collectFiles: CollectStage = async (
  ctx: PipelineContext,
): Promise<CollectedFile[]> => {
  const { repoRoot, repoId, config, store, force } = ctx;

  const existingHashes = force
    ? new Map<string, string>()
    : await loadExistingHashes(repoRoot, repoId, store);

  const collected: CollectedFile[] = [];

  for await (const relPath of walkRepo(repoRoot)) {
    const absPath = path.join(repoRoot, relPath);
    const file = Bun.file(absPath);

    if (file.size > MAX_FILE_SIZE) continue;

    const raw = await file.text();
    const content = raw.replace(/\0/g, "");

    const result = await processFile(
      { relPath, absPath, content },
      existingHashes,
      !!force,
      config.skeletonFallbackLines,
      ctx.formatter,
    );
    if (result) collected.push(result);
  }

  return collected;
};
