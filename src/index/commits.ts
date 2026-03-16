import path from "path";
import { logEvent } from "../logging";

// ---------------------------------------------------------------------------
// Result type — makes success vs failure explicit for callers
// ---------------------------------------------------------------------------

type GitResult = { ok: true; stdout: string } | { ok: false; error: Error; exitCode: number };

// ---------------------------------------------------------------------------
// Git runner with structured error logging
// ---------------------------------------------------------------------------

interface CommitEntry {
  hash: string;
  message: string;
  date: string;
}

async function runGit(args: string[], operation: string): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      const error = new Error(stderr.trim() || `git exited with code ${exitCode}`);
      logEvent({
        event: "infra.git.failure",
        error: {
          type: "GitCommandError",
          message: error.message,
          code: exitCode,
        },
        operation,
      });
      return { ok: false, error, exitCode };
    }

    return { ok: true, stdout };
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    logEvent({
      event: "infra.git.failure",
      error: {
        type: error.constructor.name,
        message: error.message,
      },
      operation,
    });
    return { ok: false, error, exitCode: 1 };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getRepoOrigin(repoRoot: string): Promise<string | null> {
  const result = await runGit(
    ["-C", repoRoot, "config", "--get", "remote.origin.url"],
    "getRepoOrigin",
  );
  if (!result.ok) return null;
  const trimmed = result.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function getRepoName(repoRoot: string): Promise<string> {
  return path.basename(repoRoot);
}

export async function getChangedFiles(repoRoot: string, commitHash?: string): Promise<string[]> {
  const args = commitHash
    ? ["-C", repoRoot, "diff-tree", "--no-commit-id", "--name-only", "-r", commitHash]
    : ["-C", repoRoot, "diff", "--name-only", "HEAD"];

  const result = await runGit(args, "getChangedFiles");
  if (!result.ok) return [];

  return result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

function parseCommitOutput(output: string): CommitEntry[] {
  const lines = output.trim().split("\n");
  const result: CommitEntry[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const hash = lines[i].trim();
    if (hash.length === 0) continue;
    result.push({ hash, message: lines[i + 1].trim(), date: lines[i + 2].trim() });
  }
  return result;
}

export async function getFileCommits(
  repoRoot: string,
  filePath: string,
  depth: number,
): Promise<CommitEntry[]> {
  const result = await runGit(
    ["-C", repoRoot, "log", "--format=%H%n%s%n%aI", `-n`, String(depth), "--", filePath],
    "getFileCommits",
  );
  if (!result.ok) return [];
  return parseCommitOutput(result.stdout);
}

export async function getRecentCommits(repoRoot: string, count: number): Promise<CommitEntry[]> {
  const result = await runGit(
    ["-C", repoRoot, "log", "--format=%H%n%s%n%aI", `-n`, String(count)],
    "getRecentCommits",
  );
  if (!result.ok) return [];
  return parseCommitOutput(result.stdout);
}
