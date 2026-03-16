// File resolution — 5-step priority chain
// Resolves file content by origin URL, commit hash, and file path

import { createHash } from "crypto";
import nodePath from "path";
import os from "os";
import { existsSync } from "fs";
import { flag, hasFlag, type ParsedArgs } from "../cli";
import { logEvent } from "../logging";
import { repoGetAll } from "../repo";
import { getRepoOrigin } from "../index/commits";
import { ensureClone, fetchCommit, readFileFromCache } from "./git-cache";
import { RelayClient } from "./relay-client";
import { CloudClient } from "../cloud/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResolveResult {
  content: string;
  strategy: string;
}

interface ResolveFailure {
  error: string;
  strategies_tried: string[];
}

type StrategyFn = () => Promise<ResolveResult | null>;

// ---------------------------------------------------------------------------
// Git helpers (local repo checks)
// ---------------------------------------------------------------------------

async function runGitCheck(args: string[]): Promise<{ ok: true; stdout: string } | { ok: false }> {
  try {
    const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return { ok: false };
    const stdout = await new Response(proc.stdout).text();
    return { ok: true, stdout };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: Local filesystem — check registered repos
// ---------------------------------------------------------------------------

async function strategyLocal(
  originUrl: string,
  commitHash: string,
  filePath: string,
): Promise<ResolveResult | null> {
  const repoRoot = process.cwd();
  let repos: Array<{ name: string; root_path: string }>;
  try {
    repos = await repoGetAll(repoRoot);
  } catch {
    return null;
  }

  for (const repo of repos) {
    // Check if this repo's origin matches
    const repoOrigin = await getRepoOrigin(repo.root_path);
    if (!repoOrigin || !urlsMatch(repoOrigin, originUrl)) continue;

    // Check if the commit exists locally
    const catFile = await runGitCheck(["-C", repo.root_path, "cat-file", "-t", commitHash]);
    if (!catFile.ok) continue;

    // Read the file at that commit
    const show = await runGitCheck(["-C", repo.root_path, "show", `${commitHash}:${filePath}`]);
    if (!show.ok) continue;

    logEvent({ event: "infra.resolve.strategy", strategy: "local", status: "success" });
    return { content: show.stdout, strategy: "local" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Strategy 2: Local git cache
// ---------------------------------------------------------------------------

async function strategyCache(
  originUrl: string,
  commitHash: string,
  filePath: string,
): Promise<ResolveResult | null> {
  // Try reading directly from existing cache
  const { cachePath } = getCachePath(originUrl);
  if (!cachePath) return null;

  let content = await readFileFromCache(cachePath, commitHash, filePath);
  if (content !== null) {
    logEvent({ event: "infra.resolve.strategy", strategy: "cache", status: "success" });
    return { content, strategy: "cache" };
  }

  // Cache exists but commit might not be fetched yet
  const fetched = await fetchCommit(cachePath, commitHash);
  if (!fetched) return null;

  content = await readFileFromCache(cachePath, commitHash, filePath);
  if (content !== null) {
    logEvent({ event: "infra.resolve.strategy", strategy: "cache-fetch", status: "success" });
    return { content, strategy: "cache" };
  }

  return null;
}

function getCachePath(originUrl: string): { cachePath: string | null } {
  const key = createHash("sha256").update(originUrl).digest("hex").slice(0, 16);
  const dir = nodePath.join(os.homedir(), ".cache", "cidx", "repos", key);

  if (existsSync(nodePath.join(dir, "HEAD"))) {
    return { cachePath: dir };
  }
  return { cachePath: null };
}

// ---------------------------------------------------------------------------
// Strategy 3: Git remote fetch — clone if needed, then fetch + read
// ---------------------------------------------------------------------------

async function strategyRemote(
  originUrl: string,
  commitHash: string,
  filePath: string,
): Promise<ResolveResult | null> {
  try {
    const cPath = await ensureClone(originUrl);
    const fetched = await fetchCommit(cPath, commitHash);
    if (!fetched) return null;

    const content = await readFileFromCache(cPath, commitHash, filePath);
    if (content !== null) {
      logEvent({ event: "infra.resolve.strategy", strategy: "remote", status: "success" });
      return { content, strategy: "remote" };
    }
  } catch (err) {
    logEvent({
      event: "infra.resolve.strategy",
      strategy: "remote",
      status: "error",
      error: { message: err instanceof Error ? err.message : String(err) },
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strategy 4: Peer relay
// ---------------------------------------------------------------------------

async function strategyRelay(
  originUrl: string,
  commitHash: string,
  filePath: string,
): Promise<ResolveResult | null> {
  let client: RelayClient | null = null;
  try {
    const cloud = new CloudClient();
    await cloud.loadCredentials();
    if (!cloud.isAuthenticated()) return null;

    client = new RelayClient(cloud.baseUrl, "");
    await client.connect();

    const content = await client.resolve(originUrl, commitHash, filePath);
    if (content !== null) {
      logEvent({ event: "infra.resolve.strategy", strategy: "relay", status: "success" });
      return { content, strategy: "relay" };
    }
  } catch (err) {
    logEvent({
      event: "infra.resolve.strategy",
      strategy: "relay",
      status: "error",
      error: { message: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    client?.disconnect();
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL matching — normalize for comparison
// ---------------------------------------------------------------------------

function normalizeUrl(url: string): string {
  // Remove trailing .git
  let normalized = url.replace(/\.git$/, "");
  // Convert SSH to HTTPS-like for comparison
  normalized = normalized.replace(/^git@([^:]+):/, "https://$1/");
  // Remove trailing slashes
  normalized = normalized.replace(/\/+$/, "");
  return normalized.toLowerCase();
}

function urlsMatch(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b);
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

export async function resolve(
  originUrl: string,
  commitHash: string,
  filePath: string,
  forceStrategy?: number,
): Promise<ResolveResult | ResolveFailure> {
  const strategies: Array<{ name: string; fn: StrategyFn }> = [
    { name: "local", fn: () => strategyLocal(originUrl, commitHash, filePath) },
    { name: "cache", fn: () => strategyCache(originUrl, commitHash, filePath) },
    { name: "remote", fn: () => strategyRemote(originUrl, commitHash, filePath) },
    { name: "relay", fn: () => strategyRelay(originUrl, commitHash, filePath) },
  ];

  const tried: string[] = [];

  // If a specific strategy is forced, only try that one
  if (forceStrategy !== undefined && forceStrategy >= 1 && forceStrategy <= 4) {
    const strat = strategies[forceStrategy - 1];
    tried.push(strat.name);
    try {
      const result = await strat.fn();
      if (result) return result;
    } catch (err) {
      logEvent({
        event: "infra.resolve.strategy",
        strategy: strat.name,
        status: "error",
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
    return { error: "unavailable", strategies_tried: tried };
  }

  // Try each strategy in order
  for (const strat of strategies) {
    tried.push(strat.name);
    try {
      const result = await strat.fn();
      if (result) return result;
      logEvent({ event: "infra.resolve.strategy", strategy: strat.name, status: "miss" });
    } catch (err) {
      logEvent({
        event: "infra.resolve.strategy",
        strategy: strat.name,
        status: "error",
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  return { error: "unavailable", strategies_tried: tried };
}

// ---------------------------------------------------------------------------
// CLI: cidx resolve <origin_url> <commit_hash> <file_path>
// ---------------------------------------------------------------------------

export async function cmdResolve(parsed: ParsedArgs): Promise<void> {
  const originUrl = parsed.positional[0];
  const commitHash = parsed.positional[1];
  const filePath = parsed.positional[2];
  const jsonOutput = hasFlag(parsed, "json");
  const strategyNum = flag(parsed, "strategy")
    ? parseInt(flag(parsed, "strategy")!, 10)
    : undefined;

  if (!originUrl || !commitHash || !filePath) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: "missing arguments" }));
    } else {
      console.error(
        "Usage: cidx resolve <origin_url> <commit_hash> <file_path> [--json] [--strategy <N>]",
      );
    }
    process.exit(1);
  }

  const result = await resolve(originUrl, commitHash, filePath, strategyNum);

  if ("error" in result) {
    if (jsonOutput) {
      console.log(JSON.stringify(result));
    } else {
      console.error("file unavailable — not pushed and peer offline");
      console.error(`Strategies tried: ${(result as ResolveFailure).strategies_tried.join(", ")}`);
    }
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(
      JSON.stringify({
        content: result.content,
        strategy: result.strategy,
        origin_url: originUrl,
        commit_hash: commitHash,
        file_path: filePath,
      }),
    );
  } else {
    process.stdout.write(result.content);
  }
}
