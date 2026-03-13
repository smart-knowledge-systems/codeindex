import path from "path";
import { loadConfig } from "../config";
import { ensurePgSchema } from "../db/schema";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { setCurrentRepo } from "../cost";
import { walkRepo } from "./walker";
import { extractSkeletonWithEntries, initParser } from "./skeleton";
import { formatAndHash } from "./formatter";
import { scanForSecrets } from "./secrets";
import { embed } from "./embedder";
import { getRepoOrigin, getRepoName } from "./commits";
import { buildDirectoryIndex } from "./directories";
import { serializeEmbedding } from "../db/util";
import { detectFormatter } from "../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoTarget {
  root: string;
  name: string;
}

export interface RepoResult {
  repo: string;
  status: "ok" | "error";
  error?: string;
}

// ---------------------------------------------------------------------------
// Semaphore for concurrency control
// ---------------------------------------------------------------------------

class Semaphore {
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.running--;
    }
  }
}

// ---------------------------------------------------------------------------
// Single-repo reindex worker
// ---------------------------------------------------------------------------

async function reindexOne(
  repoRoot: string,
  repoName: string,
  workerBudget: number,
  tag: string,
): Promise<void> {
  const config = await loadConfig(repoRoot);
  if (workerBudget > 0) {
    config.costCap = { ...config.costCap, maxCostPerReindex: workerBudget };
  }

  const origin = await getRepoOrigin(repoRoot);
  const name = await getRepoName(repoRoot);
  const formatter = config.formatter ?? (await detectFormatter(repoRoot));

  // Ensure repo row exists
  let repoId: number;
  if (config.store === "pg") {
    await ensurePgSchema();
    const existing = await pgUnsafe("SELECT id FROM repos WHERE root_path = $1", [repoRoot]);
    if (existing.length > 0) {
      repoId = existing[0].id as number;
    } else {
      const inserted = await pgUnsafe(
        "INSERT INTO repos (origin_url, root_path, name, formatter_cmd) VALUES ($1, $2, $3, $4) RETURNING id",
        [origin, repoRoot, name, formatter],
      );
      repoId = inserted[0].id as number;
    }
  } else {
    const db = await getSqlite(repoRoot);
    const existing = db.prepare("SELECT id FROM repos WHERE root_path = ?").all(repoRoot) as {
      id: number;
    }[];
    if (existing.length > 0) {
      repoId = existing[0].id;
    } else {
      const result = db
        .prepare(
          "INSERT INTO repos (origin_url, root_path, name, formatter_cmd) VALUES (?, ?, ?, ?) RETURNING id",
        )
        .get(origin, repoRoot, name, formatter) as { id: number };
      repoId = result.id;
    }
  }

  setCurrentRepo(repoId, repoRoot);
  await initParser();

  process.stderr.write(`${tag} Scanning files...\n`);

  // Bulk-fetch existing file hashes to avoid N sequential DB round-trips
  const existingHashes = new Map<string, string>();
  if (config.store === "pg") {
    const rows = (await pgUnsafe(
      "SELECT file_path, content_hash FROM files WHERE repo_id = $1",
      [repoId],
    )) as { file_path: string; content_hash: string }[];
    for (const r of rows) existingHashes.set(r.file_path, r.content_hash);
  } else {
    const db = await getSqlite(repoRoot);
    const rows = db
      .prepare("SELECT file_path, content_hash FROM files WHERE repo_id = ?")
      .all(repoId) as { file_path: string; content_hash: string }[];
    for (const r of rows) existingHashes.set(r.file_path, r.content_hash);
  }

  const allFiles: string[] = [];
  let skipped = 0;

  const filesToEmbed: {
    filePath: string;
    skeleton: string;
    skeletonEntries: string | null;
    hash: string;
    fileType: string;
  }[] = [];

  for await (const relPath of walkRepo(repoRoot)) {
    allFiles.push(relPath);
    const absPath = path.join(repoRoot, relPath);
    const content = await Bun.file(absPath).text();

    const scan = scanForSecrets(content);
    if (scan.hasSecrets) {
      skipped++;
      continue;
    }

    const ext = path.extname(relPath).toLowerCase() || ".txt";
    const { hash } = await formatAndHash(content, formatter);

    if (existingHashes.get(relPath) === hash) {
      skipped++;
      continue;
    }

    const { text: skeleton, entries } = await extractSkeletonWithEntries(
      relPath,
      content,
      config.skeletonFallbackLines,
    );
    const skeletonEntries = entries.length > 0 ? JSON.stringify(entries) : null;
    filesToEmbed.push({ filePath: relPath, skeleton, skeletonEntries, hash, fileType: ext });
  }

  if (filesToEmbed.length === 0) {
    process.stderr.write(`${tag} Nothing to index (${skipped} unchanged)\n`);
    return;
  }

  process.stderr.write(`${tag} Embedding ${filesToEmbed.length} files...\n`);
  const embeddings = await embed(filesToEmbed.map((f) => f.skeleton));

  if (config.store === "pg") {
    await pgUnsafe("BEGIN");
    try {
      for (let i = 0; i < filesToEmbed.length; i++) {
        const f = filesToEmbed[i];
        const embedding = embeddings[i];
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
          [
            repoId,
            f.filePath,
            f.hash,
            f.skeleton,
            f.skeletonEntries,
            f.fileType,
            serializeEmbedding(embedding),
          ],
        );
      }
      await pgUnsafe("COMMIT");
    } catch (err) {
      await pgUnsafe("ROLLBACK");
      throw err;
    }
  } else {
    const db = await getSqlite(repoRoot);
    const stmt = db.prepare(
      `INSERT INTO files (repo_id, file_path, content_hash, skeleton, skeleton_entries, file_type, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, file_path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         skeleton = EXCLUDED.skeleton,
         skeleton_entries = EXCLUDED.skeleton_entries,
         file_type = EXCLUDED.file_type,
         embedding = EXCLUDED.embedding,
         indexed_at = datetime('now')`,
    );
    for (let i = 0; i < filesToEmbed.length; i++) {
      const f = filesToEmbed[i];
      stmt.run(
        repoId,
        f.filePath,
        f.hash,
        f.skeleton,
        f.skeletonEntries,
        f.fileType,
        serializeEmbedding(embeddings[i]),
      );
    }
  }

  // Build directory index
  process.stderr.write(`${tag} Building directory index...\n`);
  await buildDirectoryIndex(repoRoot, repoId, allFiles);

  process.stderr.write(`${tag} Done: ${filesToEmbed.length} indexed, ${skipped} unchanged\n`);
}

// ---------------------------------------------------------------------------
// Parallel reindex orchestrator
// ---------------------------------------------------------------------------

export async function parallelReindex(
  repos: RepoTarget[],
  workers: number,
  costBudget: number,
): Promise<RepoResult[]> {
  const concurrency = Math.min(workers, repos.length);
  const perRepoBudget = costBudget > 0 ? costBudget / repos.length : 0;
  const semaphore = new Semaphore(concurrency);

  process.stderr.write(
    `Parallel reindex: ${repos.length} repos, ${concurrency} workers` +
      (costBudget > 0
        ? `, $${costBudget.toFixed(4)} budget ($${perRepoBudget.toFixed(4)}/repo)`
        : "") +
      "\n",
  );

  const tasks = repos.map(async (repo, idx): Promise<RepoResult> => {
    await semaphore.acquire();
    const tag = `[${idx + 1}/${repos.length} ${repo.name}]`;
    try {
      process.stderr.write(`${tag} Starting...\n`);
      await reindexOne(repo.root, repo.name, perRepoBudget, tag);
      return { repo: repo.name, status: "ok" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${tag} FAILED: ${msg}\n`);
      return { repo: repo.name, status: "error", error: msg };
    } finally {
      semaphore.release();
    }
  });

  return Promise.allSettled(tasks).then((settled) =>
    settled.map((s) =>
      s.status === "fulfilled"
        ? s.value
        : { repo: "unknown", status: "error" as const, error: String(s.reason) },
    ),
  );
}
