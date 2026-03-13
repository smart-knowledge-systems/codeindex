import path from "path";

interface CommitEntry {
  hash: string;
  message: string;
  date: string;
}

async function runGit(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { stdout, exitCode };
  } catch {
    return { stdout: "", exitCode: 1 };
  }
}

export async function getRepoOrigin(repoRoot: string): Promise<string | null> {
  const { stdout, exitCode } = await runGit([
    "-C",
    repoRoot,
    "config",
    "--get",
    "remote.origin.url",
  ]);
  if (exitCode !== 0) {
    return null;
  }
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function getRepoName(repoRoot: string): Promise<string> {
  return path.basename(repoRoot);
}

export async function getChangedFiles(repoRoot: string, commitHash?: string): Promise<string[]> {
  const args = commitHash
    ? ["-C", repoRoot, "diff-tree", "--no-commit-id", "--name-only", "-r", commitHash]
    : ["-C", repoRoot, "diff", "--name-only", "HEAD"];

  const { stdout, exitCode } = await runGit(args);
  if (exitCode !== 0) {
    return [];
  }

  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

function parseCommitOutput(output: string): CommitEntry[] {
  const lines = output.trim().split("\n");
  const commits: CommitEntry[] = [];

  for (let i = 0; i + 2 < lines.length; i += 3) {
    const hash = lines[i].trim();
    const message = lines[i + 1].trim();
    const date = lines[i + 2].trim();

    if (hash.length > 0) {
      commits.push({ hash, message, date });
    }
  }

  return commits;
}

export async function getFileCommits(
  repoRoot: string,
  filePath: string,
  depth: number,
): Promise<CommitEntry[]> {
  const { stdout, exitCode } = await runGit([
    "-C",
    repoRoot,
    "log",
    "--format=%H%n%s%n%aI",
    `-n`,
    String(depth),
    "--",
    filePath,
  ]);

  if (exitCode !== 0) {
    return [];
  }

  return parseCommitOutput(stdout);
}

export async function getRecentCommits(repoRoot: string, count: number): Promise<CommitEntry[]> {
  const { stdout, exitCode } = await runGit([
    "-C",
    repoRoot,
    "log",
    "--format=%H%n%s%n%aI",
    `-n`,
    String(count),
  ]);

  if (exitCode !== 0) {
    return [];
  }

  return parseCommitOutput(stdout);
}
