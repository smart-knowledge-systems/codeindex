import path from "path";
import { loadConfig, detectFormatter } from "../config";
import { ensurePgSchema, ensureSqliteSchema } from "../db/schema";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { getRepoOrigin, getRepoName } from "../index/commits";
import { MAX_FILE_SIZE } from "../index/walker";
import { scanForSecrets } from "../index/secrets";
import { formatAndHash } from "../index/formatter";
import { extractSkeletonWithEntries } from "../index/skeleton";
import { extractImports } from "../index/imports";

export async function ensureRepo(repoRoot: string): Promise<number> {
  const config = await loadConfig(repoRoot);
  const origin = await getRepoOrigin(repoRoot);
  const name = await getRepoName(repoRoot);
  const formatter = config.formatter ?? (await detectFormatter(repoRoot));

  if (config.store === "pg") {
    await ensurePgSchema();
    const existing = await pgUnsafe("SELECT id FROM repos WHERE root_path = $1", [repoRoot]);
    if (existing.length > 0) return existing[0].id as number;

    const inserted = await pgUnsafe(
      "INSERT INTO repos (origin_url, root_path, name, formatter_cmd) VALUES ($1, $2, $3, $4) RETURNING id",
      [origin, repoRoot, name, formatter],
    );
    return inserted[0].id as number;
  } else {
    await ensureSqliteSchema(repoRoot);
    const db = await getSqlite(repoRoot);
    const existing = db.prepare("SELECT id FROM repos WHERE root_path = ?").all(repoRoot) as {
      id: number;
    }[];
    if (existing.length > 0) return existing[0].id;

    const result = db
      .prepare(
        "INSERT INTO repos (origin_url, root_path, name, formatter_cmd) VALUES (?, ?, ?, ?) RETURNING id",
      )
      .get(origin, repoRoot, name, formatter) as { id: number };
    return result.id;
  }
}

export async function collectChangedFiles(
  ctx: import("../pipeline").PipelineContext,
  relPaths: string[],
): Promise<import("../pipeline").CollectedFile[]> {
  const { repoRoot, repoId, config, formatter, store } = ctx;

  // Load existing hashes for dedup — built immutably from DB rows
  const hashRows: { file_path: string; content_hash: string }[] =
    store === "pg"
      ? ((await pgUnsafe("SELECT file_path, content_hash FROM files WHERE repo_id = $1", [
          repoId,
        ])) as { file_path: string; content_hash: string }[])
      : ((await getSqlite(repoRoot))
          .prepare("SELECT file_path, content_hash FROM files WHERE repo_id = ?")
          .all(repoId) as { file_path: string; content_hash: string }[]);

  const existingHashes = new Map(hashRows.map((r) => [r.file_path, r.content_hash] as const));

  const collected: import("../pipeline").CollectedFile[] = [];

  for (const relPath of relPaths) {
    const absPath = path.join(repoRoot, relPath);
    const file = Bun.file(absPath);
    if (file.size > MAX_FILE_SIZE) continue;

    const content = (await file.text()).replace(/\0/g, "");

    const scan = scanForSecrets(content);
    if (scan.hasSecrets) {
      console.warn(`  SKIP ${relPath}: potential secrets (${scan.patterns.join(", ")})`);
      continue;
    }

    const ext = path.extname(relPath).toLowerCase() || ".txt";
    const { hash } = await formatAndHash(content, formatter);

    if (existingHashes.get(relPath) === hash) continue;

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
}

export async function getCommitMessage(repoRoot: string, hash: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "-C", repoRoot, "log", "--format=%s", "-n", "1", hash], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  return (await new Response(proc.stdout).text()).trim();
}
