import path from "path";
import { loadConfig, detectFormatter } from "../config";
import { ensurePgSchema } from "../db/schema";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { withCostContext } from "../cost";
import { walkRepo, MAX_FILE_SIZE } from "./walker";
import { initParser } from "./skeleton";
import { getRepoOrigin, getRepoName } from "./commits";
import { collectFiles, embedFiles, storeFiles, pruneStale, summarizeDirs } from "../pipeline";
import type { PipelineContext, SummaryProvider } from "../pipeline";
import { logEvent } from "../logging";

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

  await initParser();

  await withCostContext({ repoId, repoRoot, store: config.store }, async () => {
    const start = performance.now();
    process.stderr.write(`${tag} Scanning files...\n`);
    logEvent({ event: "infra.reindex.started", repo_name: repoName });

    const ctx: PipelineContext = {
      repoRoot,
      repoId,
      config,
      formatter,
      store: config.store,
      dryRun: false,
      force: false,
    };

    const collected = await collectFiles(ctx);

    // Walk repo for the full file list (needed for prune/summarize)
    const allFiles: string[] = [];
    for await (const relPath of walkRepo(repoRoot)) {
      const absPath = path.join(repoRoot, relPath);
      if (Bun.file(absPath).size <= MAX_FILE_SIZE) {
        allFiles.push(relPath);
      }
    }

    if (collected.length === 0) {
      process.stderr.write(
        `${tag} Nothing to index (${allFiles.length - collected.length} unchanged)\n`,
      );
      logEvent({
        event: "infra.reindex.completed",
        repo_name: repoName,
        files_indexed: 0,
        files_unchanged: allFiles.length,
        duration_ms: Math.round(performance.now() - start),
      });
      return;
    }

    process.stderr.write(`${tag} Embedding ${collected.length} files...\n`);
    const embedded = await embedFiles(ctx, collected);

    if (embedded.length === 0) {
      // Cost cap exceeded
      return;
    }

    await storeFiles(ctx, embedded);

    const pruned = await pruneStale(ctx, new Set(allFiles));
    if (pruned > 0) {
      process.stderr.write(`${tag} Pruned ${pruned} stale entries\n`);
    }

    process.stderr.write(`${tag} Building directory index...\n`);
    const nullSummaryProvider: SummaryProvider = {
      name: "none",
      summarizeDirectory: async () => null,
    };
    await summarizeDirs(ctx, allFiles, nullSummaryProvider);

    process.stderr.write(
      `${tag} Done: ${embedded.length} indexed, ${allFiles.length - embedded.length} unchanged\n`,
    );
    logEvent({
      event: "infra.reindex.completed",
      repo_name: repoName,
      files_indexed: embedded.length,
      files_unchanged: allFiles.length - embedded.length,
      pruned,
      duration_ms: Math.round(performance.now() - start),
    });
  });
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
  logEvent({
    event: "infra.reindex.parallel_started",
    repo_count: repos.length,
    concurrency,
    cost_budget: costBudget,
  });

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
      logEvent({
        event: "infra.reindex.repo_failed",
        repo_name: repo.name,
        "error.type": err instanceof Error ? err.constructor.name : "unknown",
        "error.message": msg,
      });
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
