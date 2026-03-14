import { existsSync } from "fs";
import { readdir } from "fs/promises";
import path from "path";

export interface DiscoveredRepo {
  absPath: string;
  name: string;
  hasGit: boolean;
  hasIndexIgnore: boolean;
  estimatedFileCount: number;
}

/**
 * Scan a directory one level deep for git repositories.
 * Returns repos sorted by name.
 */
export async function discoverRepos(scanDir: string): Promise<DiscoveredRepo[]> {
  const absDir = path.resolve(scanDir);
  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    throw new Error(`Cannot read directory: ${absDir}`);
  }

  const repos: DiscoveredRepo[] = [];

  for (const entry of entries) {
    const entryPath = path.join(absDir, entry);
    const gitPath = path.join(entryPath, ".git");
    const hasGit = existsSync(path.join(gitPath, "HEAD"));
    if (!hasGit) continue;

    const hasIndexIgnore = existsSync(path.join(entryPath, ".indexignore"));
    const estimatedFileCount = await estimateFileCount(entryPath);

    repos.push({
      absPath: entryPath,
      name: entry,
      hasGit,
      hasIndexIgnore,
      estimatedFileCount,
    });
  }

  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fast file count using git ls-files.
 * Falls back to 0 on error.
 */
export async function estimateFileCount(repoPath: string): Promise<number> {
  try {
    const proc = Bun.spawn(["git", "ls-files"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text
      .trim()
      .split("\n")
      .filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}
