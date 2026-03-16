// Cloud reindex command
// Implemented by cloud-commands agent, refined by ingest agent

import path from "path";
import os from "os";
import { hasFlag, type ParsedArgs } from "../cli";
import { loadConfig } from "../config";
import { getSqlite } from "../db/sqlite";
import { ensureSqliteSchema } from "../db/schema";
import { collectFiles } from "../pipeline/collect";
import type { CollectedFile, PipelineContext } from "../pipeline/types";
import { getRepoOrigin } from "../index/commits";
import { CloudClient } from "./client";
import { CloudRateLimitError } from "./errors";
import { formatError } from "../errors";

// ---------------------------------------------------------------------------
// Privacy: strip sensitive fields before sending to cloud
// ---------------------------------------------------------------------------

export interface CloudSafeFile {
  relPath: string;
  contentHash: string;
  skeleton: string;
  skeletonEntries: string | null;
  fileType: string;
  importEdges: CollectedFile["importEdges"];
}

export function stripForCloud(file: CollectedFile): CloudSafeFile {
  return {
    relPath: file.relPath,
    contentHash: file.contentHash,
    skeleton: file.skeleton,
    skeletonEntries: file.skeletonEntries,
    fileType: file.fileType,
    importEdges: file.importEdges,
  };
}

// ---------------------------------------------------------------------------
// Checkpoint (resumable ingest)
// ---------------------------------------------------------------------------

interface Checkpoint {
  jobId: string;
  startedAt: number;
  batches: Record<number, "sent" | "acked">;
}

const CHECKPOINT_DIR = path.join(os.homedir(), ".cache", "cidx", "ingest");
const STALE_TIMEOUT_MS = Number(process.env.CIDX_INGEST_TIMEOUT) || 3_600_000; // 1h default

function checkpointPath(jobId: string): string {
  return path.join(CHECKPOINT_DIR, `${jobId}.json`);
}

async function loadCheckpoint(jobId: string): Promise<Checkpoint | null> {
  try {
    const file = Bun.file(checkpointPath(jobId));
    if (!(await file.exists())) return null;
    const cp = (await file.json()) as Checkpoint;
    if (Date.now() - cp.startedAt > STALE_TIMEOUT_MS) return null; // stale
    return cp;
  } catch {
    return null;
  }
}

async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  const dir = path.dirname(checkpointPath(cp.jobId));
  await Bun.write(path.join(dir, ".keep"), ""); // ensure dir exists
  await Bun.write(checkpointPath(cp.jobId), JSON.stringify(cp));
}

async function removeCheckpoint(jobId: string): Promise<void> {
  try {
    const fs = await import("fs/promises");
    await fs.unlink(checkpointPath(jobId));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Parallel batch runner with backpressure
// ---------------------------------------------------------------------------

async function parallelBatches<T>(
  batches: T[],
  concurrency: number,
  fn: (batch: T, index: number) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const run = async () => {
    while (idx < batches.length) {
      const i = idx++;
      await fn(batches[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, run));
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function renderProgress(
  done: number,
  total: number,
  batchDone: number,
  batchTotal: number,
  startMs: number,
): string {
  const width = 20;
  const filled = total > 0 ? Math.round((done / total) * width) : 0;
  const bar =
    "=".repeat(filled) + (filled < width ? ">" : "") + " ".repeat(Math.max(0, width - filled - 1));
  const elapsed = Date.now() - startMs;
  const eta = done > 0 ? Math.round(((elapsed / done) * (total - done)) / 1000) : 0;
  return `\r[${bar}] ${done}/${total} files | Batch ${batchDone}/${batchTotal} | ETA ${eta}s`;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cloudReindex(repoRoot: string, parsed: ParsedArgs): Promise<void> {
  const client = new CloudClient();
  await client.loadCredentials();

  if (!client.isAuthenticated()) {
    process.stderr.write("Not logged in. Run `cidx cloud login` to authenticate.\n");
    process.exit(1);
  }

  const dryRun = hasFlag(parsed, "dry-run");
  const quiet = hasFlag(parsed, "quiet");
  const batchSize = Number(process.env.CIDX_BATCH_SIZE) || 50;

  // Collect files locally
  if (!quiet) process.stderr.write("Collecting files...\n");
  const config = await loadConfig(repoRoot);
  await ensureSqliteSchema(repoRoot);
  const db = await getSqlite(repoRoot);

  // Get or create repo record
  let repoRow = db.prepare("SELECT id FROM repos WHERE root_path = ?").get(repoRoot) as {
    id: number;
  } | null;
  if (!repoRow) {
    const origin = await getRepoOrigin(repoRoot);
    const name = path.basename(repoRoot);
    db.prepare("INSERT OR IGNORE INTO repos (origin_url, root_path, name) VALUES (?, ?, ?)").run(
      origin,
      repoRoot,
      name,
    );
    repoRow = db.prepare("SELECT id FROM repos WHERE root_path = ?").get(repoRoot) as {
      id: number;
    };
  }

  const ctx: PipelineContext = {
    repoRoot,
    repoId: repoRow!.id,
    config,
    formatter: config.formatter ?? null,
    store: "sqlite",
    dryRun: false,
    force: true, // bypass local hash dedup — let the cloud decide
  };

  const collected = await collectFiles(ctx);
  if (!quiet) process.stderr.write(`Collected ${collected.length} files\n`);

  if (dryRun) {
    process.stderr.write("Dry run — nothing sent to cloud.\n");
    for (const f of collected) {
      process.stderr.write(`  ${f.relPath} (${f.contentHash.slice(0, 8)})\n`);
    }
    return;
  }

  // Begin ingest
  const origin = await getRepoOrigin(repoRoot);
  const hashes = collected.map((f) => f.contentHash);
  const startMs = Date.now();

  try {
    const begin = await client.ingestBegin({
      repo: origin ?? repoRoot,
      hashes,
    });

    // --- Task 9: Content-hash dedup ---
    const knownSet = new Set(begin.known_hashes);
    const toSend = collected.filter((f) => !knownSet.has(f.contentHash));
    const skipped = collected.length - toSend.length;
    if (!quiet) {
      process.stderr.write(
        `Skipped ${skipped} files (already indexed), uploading ${toSend.length} new/changed\n`,
      );
    }

    if (toSend.length === 0) {
      await client.ingestComplete({ jobId: begin.jobId });
      if (!quiet) process.stderr.write("Nothing to upload — all files already indexed.\n");
      return;
    }

    // --- Task 10: Batched upload with parallelism ---
    const batches: CollectedFile[][] = [];
    for (let i = 0; i < toSend.length; i += batchSize) {
      batches.push(toSend.slice(i, i + batchSize));
    }

    // --- Task 11: Resumable ingest (checkpoint) ---
    let checkpoint = await loadCheckpoint(begin.jobId);
    if (!checkpoint) {
      checkpoint = { jobId: begin.jobId, startedAt: Date.now(), batches: {} };
      await saveCheckpoint(checkpoint);
    }

    let filesDone = 0;
    // Count already-acked batches for resume
    for (const [idxStr, status] of Object.entries(checkpoint.batches)) {
      if (status === "acked") {
        const bi = Number(idxStr);
        filesDone += batches[bi]?.length ?? 0;
      }
    }

    const sendBatch = async (batch: CollectedFile[], batchIndex: number): Promise<void> => {
      // Skip already-acked batches (resume)
      if (checkpoint!.batches[batchIndex] === "acked") return;

      const safeBatch = batch.map(stripForCloud);
      const payload = {
        jobId: begin.jobId,
        files: safeBatch.map((f) => ({
          contentHash: f.contentHash,
          path: f.relPath,
          language: f.fileType,
          sizeBytes: new TextEncoder().encode(f.skeleton).length,
        })),
      };

      // Retry loop for rate limiting (backpressure)
      let attempt = 0;
      while (true) {
        try {
          checkpoint!.batches[batchIndex] = "sent";
          await saveCheckpoint(checkpoint!);

          await client.ingestBatch(payload);

          checkpoint!.batches[batchIndex] = "acked";
          await saveCheckpoint(checkpoint!);
          break;
        } catch (err) {
          if (err instanceof CloudRateLimitError && attempt < 5) {
            const delay = (err.retryAfter ?? 1) * 1000 * Math.pow(2, attempt);
            if (!quiet)
              process.stderr.write(`\nRate limited, retrying in ${Math.round(delay / 1000)}s...\n`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            attempt++;
          } else {
            throw err;
          }
        }
      }

      filesDone += batch.length;

      // --- Task 12: Progress reporting ---
      if (!quiet) {
        process.stderr.write(
          renderProgress(filesDone, toSend.length, batchIndex + 1, batches.length, startMs),
        );
      }

      // Best-effort progress report to cloud
      try {
        await client.request("POST", "/ingest/progress", {
          jobId: begin.jobId,
          processed: filesDone,
          total: toSend.length,
        });
      } catch {
        // best-effort — ignore errors
      }
    };

    await parallelBatches(batches, 2, sendBatch);

    if (!quiet) process.stderr.write("\n"); // newline after progress bar

    // Complete
    const result = await client.ingestComplete({ jobId: begin.jobId });

    // Clean up checkpoint on success
    await removeCheckpoint(begin.jobId);

    // Final summary
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    if (!quiet) {
      process.stderr.write(
        `Reindex complete: ${result.files_indexed} files indexed, cost $${result.cost_usd.toFixed(4)}, ` +
          `${elapsed}s elapsed` +
          (skipped > 0 ? `, ${skipped} files deduped` : "") +
          "\n",
      );
    }
  } catch (err) {
    process.stderr.write(`Cloud reindex failed: ${formatError(err)}\n`);
    process.exit(1);
  }
}
