// Git clone cache manager
// Manages bare git clones for file resolution

import { createHash } from "crypto";
import path from "path";
import os from "os";
import { existsSync } from "fs";
import { readdir, rm, stat, writeFile, readFile, unlink, utimes } from "fs/promises";
import { flag, hasFlag, type ParsedArgs } from "../cli";
import { logEvent } from "../logging";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_ROOT = path.join(os.homedir(), ".cache", "cidx", "repos");
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cacheKey(originUrl: string): string {
  return createHash("sha256").update(originUrl).digest("hex").slice(0, 16);
}

function cachePath(originUrl: string): string {
  return path.join(CACHE_ROOT, cacheKey(originUrl));
}

async function runGit(
  args: string[],
  operation: string,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      logEvent({
        event: "infra.git.failure",
        operation,
        error: { type: "GitCommandError", message: stderr.trim() },
      });
      return { ok: false, error: stderr.trim(), exitCode };
    }
    return { ok: true, stdout };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent({
      event: "infra.git.failure",
      operation,
      error: { type: "SpawnError", message: msg },
    });
    return { ok: false, error: msg, exitCode: 1 };
  }
}

// ---------------------------------------------------------------------------
// File-based locking
// ---------------------------------------------------------------------------

async function acquireLock(dir: string): Promise<boolean> {
  const lockFile = dir + ".lock";
  if (existsSync(lockFile)) {
    try {
      const lockStat = await stat(lockFile);
      if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockFile);
      } else {
        return false;
      }
    } catch {
      // Lock file disappeared between check and stat — safe to proceed
    }
  }
  try {
    await writeFile(lockFile, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(dir: string): Promise<void> {
  try {
    await unlink(dir + ".lock");
  } catch {
    // Already removed
  }
}

// ---------------------------------------------------------------------------
// URL metadata file — maps cache dirs back to origin URLs
// ---------------------------------------------------------------------------

async function writeUrlMeta(dir: string, originUrl: string): Promise<void> {
  await writeFile(path.join(dir, ".cidx-origin"), originUrl);
}

async function readUrlMeta(dir: string): Promise<string | null> {
  try {
    return (await readFile(path.join(dir, ".cidx-origin"), "utf-8")).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LRU access tracking
// ---------------------------------------------------------------------------

async function touchAccess(dir: string): Promise<void> {
  const accessFile = path.join(dir, ".last-accessed");
  const now = new Date();
  try {
    await writeFile(accessFile, now.toISOString());
    await utimes(accessFile, now, now);
  } catch {
    // Non-critical
  }
}

async function getLastAccessed(dir: string): Promise<Date> {
  try {
    const accessFile = path.join(dir, ".last-accessed");
    const s = await stat(accessFile);
    return s.mtime;
  } catch {
    try {
      const s = await stat(dir);
      return s.mtime;
    } catch {
      return new Date(0);
    }
  }
}

async function getDirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        try {
          const s = await stat(path.join(entry.parentPath ?? dir, entry.name));
          total += s.size;
        } catch {
          // Skip inaccessible files
        }
      }
    }
  } catch {
    // Empty or inaccessible
  }
  return total;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function ensureClone(originUrl: string): Promise<string> {
  const dir = cachePath(originUrl);

  if (existsSync(path.join(dir, "HEAD"))) {
    await touchAccess(dir);
    return dir;
  }

  const locked = await acquireLock(dir);
  if (!locked) {
    throw new Error(`Cache lock held for ${originUrl} — another operation in progress`);
  }

  try {
    // Double-check after acquiring lock
    if (existsSync(path.join(dir, "HEAD"))) {
      await touchAccess(dir);
      return dir;
    }

    const result = await runGit(
      ["clone", "--bare", "--filter=blob:none", originUrl, dir],
      "ensureClone",
    );
    if (!result.ok) {
      throw new Error(`Failed to clone ${originUrl}: ${result.error}`);
    }

    await writeUrlMeta(dir, originUrl);
    await touchAccess(dir);
    return dir;
  } finally {
    await releaseLock(dir);
  }
}

export async function fetchCommit(cachePath: string, commitHash: string): Promise<boolean> {
  const result = await runGit(["-C", cachePath, "fetch", "origin", commitHash], "fetchCommit");
  return result.ok;
}

export async function readFileFromCache(
  cachePath: string,
  commitHash: string,
  filePath: string,
): Promise<string | null> {
  await touchAccess(cachePath);
  const result = await runGit(["-C", cachePath, "show", `${commitHash}:${filePath}`], "readFile");
  if (!result.ok) return null;
  return result.stdout;
}

export async function evict(originUrl: string): Promise<void> {
  const dir = cachePath(originUrl);
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true });
  }
  // Also remove lock file if present
  await releaseLock(dir);
}

export async function listCached(): Promise<
  Array<{ url: string; path: string; sizeBytes: number; lastAccessed: Date }>
> {
  const results: Array<{ url: string; path: string; sizeBytes: number; lastAccessed: Date }> = [];

  if (!existsSync(CACHE_ROOT)) return results;

  const entries = await readdir(CACHE_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(CACHE_ROOT, entry.name);
    const url = await readUrlMeta(dir);
    if (!url) continue;

    const [sizeBytes, lastAccessed] = await Promise.all([getDirSize(dir), getLastAccessed(dir)]);
    results.push({ url, path: dir, sizeBytes, lastAccessed });
  }

  return results;
}

export async function pruneToSize(maxBytes: number = DEFAULT_MAX_BYTES): Promise<number> {
  const cached = await listCached();
  const totalSize = cached.reduce((sum, c) => sum + c.sizeBytes, 0);

  if (totalSize <= maxBytes) return 0;

  // Sort by last accessed, oldest first (LRU)
  cached.sort((a, b) => a.lastAccessed.getTime() - b.lastAccessed.getTime());

  let freed = 0;
  let remaining = totalSize;

  for (const entry of cached) {
    if (remaining <= maxBytes) break;
    await rm(entry.path, { recursive: true, force: true });
    freed += entry.sizeBytes;
    remaining -= entry.sizeBytes;
  }

  return freed;
}

// ---------------------------------------------------------------------------
// CLI: cidx cache list | cidx cache clear [--repo <url>]
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function cmdCache(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positional[0];

  if (sub === "list") {
    const cached = await listCached();
    if (cached.length === 0) {
      console.log("No cached repositories.");
      return;
    }
    console.log(`${"URL".padEnd(50)}${"Size".padEnd(12)}Last Accessed`);
    for (const entry of cached) {
      console.log(
        `${entry.url.padEnd(50)}${formatBytes(entry.sizeBytes).padEnd(12)}${entry.lastAccessed.toISOString()}`,
      );
    }
    return;
  }

  if (sub === "clear") {
    const repoUrl = flag(parsed, "repo");
    if (repoUrl) {
      await evict(repoUrl);
      console.log(`Evicted cache for ${repoUrl}`);
    } else {
      const cached = await listCached();
      for (const entry of cached) {
        await rm(entry.path, { recursive: true, force: true });
      }
      console.log(`Cleared ${cached.length} cached repositories.`);
    }
    return;
  }

  if (hasFlag(parsed, "help") || !sub) {
    console.log("Usage: cidx cache <list|clear> [--repo <origin_url>]");
    return;
  }

  console.error(`Unknown cache subcommand: ${sub}`);
  process.exit(1);
}
