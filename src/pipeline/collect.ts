import path from "path";
import { walkRepo, MAX_FILE_SIZE } from "../index/walker";
import { extractSkeletonWithEntries } from "../index/skeleton";
import { formatAndHash } from "../index/formatter";
import { scanForSecrets } from "../index/secrets";
import { extractImports } from "../index/imports";
import { getStoreOps } from "../repo";
import { logEvent, hashPath } from "../logging";
import { isPublishedContent } from "../index/public-repo";
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
  ctx: PipelineContext,
): Promise<CollectedFile | null> {
  const scan = scanForSecrets(file.content);
  if (scan.hasSecrets) {
    if (ctx.repoVisibility === "public" && (await isPublishedContent(ctx.repoRoot, file.relPath))) {
      process.stderr.write(
        `  OVERRIDE ${file.relPath}: secret patterns [${scan.patterns.join(", ")}] overridden — public repo, published content\n`,
      );
      logEvent({
        event: "infra.secrets.override",
        file_path_hash: hashPath(file.relPath),
        patterns: scan.patterns,
      });
      if (ctx.secretOverrideCount != null) ctx.secretOverrideCount++;
    } else {
      process.stderr.write(`  SKIP ${file.relPath}: potential secrets detected\n`);
      logEvent({
        event: "infra.secrets.detected",
        file_path_hash: hashPath(file.relPath),
        patterns: scan.patterns,
      });
      return null;
    }
  }

  const ext = path.extname(file.relPath).toLowerCase() || ".txt";
  const { hash } = await formatAndHash(file.content, ctx.formatter);

  // Skip if hash matches existing DB record (dedup)
  if (!ctx.force && existingHashes.get(file.relPath) === hash) return null;

  // Global dedup-store hit: reuse skeleton + embedding verbatim, no parse, no embed.
  const cached = await lookupGlobalBlob(ctx, hash);
  if (cached) {
    if (ctx.dedupStats) ctx.dedupStats.hits++;
    return {
      relPath: file.relPath,
      absPath: file.absPath,
      fileType: ext,
      contentHash: hash,
      content: file.content,
      skeleton: cached.skeleton ?? "",
      skeletonEntries: cached.skeletonEntries,
      importEdges: extractImports(file.relPath, file.content),
      cachedEmbedding: cached.embedding,
    };
  }
  if (ctx.dedupStats) ctx.dedupStats.misses++;

  const { text: skeleton, entries } = await extractSkeletonWithEntries(
    file.relPath,
    file.content,
    ctx.config.skeletonFallbackLines,
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

/**
 * Single-blob global-store lookup, scoped to the repo's embedding config.
 * Returns null when dedup is disabled, the store is absent, or it's a miss.
 */
async function lookupGlobalBlob(
  ctx: PipelineContext,
  contentHash: string,
): Promise<{
  skeleton: string | null;
  skeletonEntries: string | null;
  embedding: number[];
} | null> {
  if (!ctx.globalStore) return null;
  const { provider, model, dimensions } = ctx.config.embedding;
  return ctx.globalStore.lookupBlob({ contentHash, provider, model, dimensions });
}

// ---------------------------------------------------------------------------
// Impure shell — I/O for loading hashes and reading files
// ---------------------------------------------------------------------------

async function loadExistingHashes(repoRoot: string, repoId: number): Promise<Map<string, string>> {
  const { ops } = await getStoreOps(repoRoot);
  const rows = await ops.query<{ file_path: string; content_hash: string }>(
    "SELECT file_path, content_hash FROM files WHERE repo_id = $1",
    [repoId],
  );
  const hashes = new Map<string, string>();
  for (const r of rows) hashes.set(r.file_path, r.content_hash);
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
  const { repoRoot, repoId, force } = ctx;

  const existingHashes = force
    ? new Map<string, string>()
    : await loadExistingHashes(repoRoot, repoId);

  const collected: CollectedFile[] = [];

  for await (const relPath of walkRepo(repoRoot)) {
    const absPath = path.join(repoRoot, relPath);
    const file = Bun.file(absPath);

    if (file.size > MAX_FILE_SIZE) continue;

    const raw = await file.text();
    const content = raw.replace(/\0/g, "");

    const result = await processFile({ relPath, absPath, content }, existingHashes, ctx);
    if (result) collected.push(result);
  }

  return collected;
};
