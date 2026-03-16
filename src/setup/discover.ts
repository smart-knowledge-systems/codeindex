import { existsSync } from "fs";
import { readdir } from "fs/promises";
import path from "path";
import { logEvent } from "../logging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredRepo {
  absPath: string;
  name: string;
  hasGit: boolean;
  hasIndexIgnore: boolean;
  estimatedFileCount: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Count non-empty lines in text (pipeline-style). */
function countNonEmptyLines(text: string): number {
  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0).length;
}

// ---------------------------------------------------------------------------
// I/O boundary
// ---------------------------------------------------------------------------

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
    return countNonEmptyLines(text);
  } catch {
    logEvent({
      event: "infra.filecount.error",
      "error.type": "SpawnFailure",
      "error.message": `git ls-files failed for ${repoPath}`,
    });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
    logEvent({
      event: "infra.discovery.error",
      "error.type": "ReadDirFailure",
      "error.message": `Cannot read directory: ${absDir}`,
    });
    throw new Error(`Cannot read directory: ${absDir}`);
  }

  const gitEntries = entries.filter((entry) => {
    const gitHead = path.join(absDir, entry, ".git", "HEAD");
    return existsSync(gitHead);
  });

  const repos = await Promise.all(
    gitEntries.map(async (entry): Promise<DiscoveredRepo> => {
      const entryPath = path.join(absDir, entry);
      return {
        absPath: entryPath,
        name: entry,
        hasGit: true,
        hasIndexIgnore: existsSync(path.join(entryPath, ".indexignore")),
        estimatedFileCount: await estimateFileCount(entryPath),
      };
    }),
  );

  return repos.sort((a, b) => a.name.localeCompare(b.name));
}
