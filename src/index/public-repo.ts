import { getRepoOrigin, runGit } from "./commits";
import { logEvent, hashPath } from "../logging";

// ---------------------------------------------------------------------------
// GitHub URL parsing
// ---------------------------------------------------------------------------

export function parseGitHubOwnerRepo(url: string): { owner: string; repo: string } | null {
  // HTTPS: https://github.com/owner/repo.git
  const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (https) return { owner: https[1], repo: https[2] };

  // SSH: git@github.com:owner/repo.git
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  return null;
}

// ---------------------------------------------------------------------------
// Repo visibility via GitHub CLI
// ---------------------------------------------------------------------------

export async function checkRepoVisibility(
  repoRoot: string,
): Promise<"public" | "private" | "unknown"> {
  const origin = await getRepoOrigin(repoRoot);
  if (!origin) return "unknown";

  const parsed = parseGitHubOwnerRepo(origin);
  if (!parsed) return "unknown";

  try {
    const proc = Bun.spawn(
      ["gh", "api", `repos/${parsed.owner}/${parsed.repo}`, "--jq", ".visibility"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    const stdout = (await new Response(proc.stdout).text()).trim();

    let result: "public" | "private" | "unknown";
    if (exitCode !== 0) {
      result = "unknown";
    } else if (stdout === "public") {
      result = "public";
    } else if (stdout === "private" || stdout === "internal") {
      result = "private";
    } else {
      result = "unknown";
    }

    logEvent({
      event: "infra.repo.visibility",
      repo_path_hash: hashPath(repoRoot),
      visibility: result,
    });

    return result;
  } catch {
    logEvent({
      event: "infra.repo.visibility",
      repo_path_hash: hashPath(repoRoot),
      visibility: "unknown",
      error: "spawn_failed",
    });
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Published content check — compares local blob hash to remote
// ---------------------------------------------------------------------------

export async function isPublishedContent(repoRoot: string, relPath: string): Promise<boolean> {
  // Reject any working-tree modification vs HEAD. The override is meant for
  // content that is *already published*, so any uncommitted edit (including a
  // freshly added secret) must disqualify the file.
  const diffResult = await runGit(
    ["-C", repoRoot, "diff", "--quiet", "HEAD", "--", relPath],
    "diffQuiet",
  );
  if (!diffResult.ok) return false;

  // Get local blob hash from HEAD's tree, not from disk. `hash-object` on a
  // working-tree file hashes raw bytes, but `ls-tree` returns the post-clean-
  // filter hash from git's object database. On any repo with .gitattributes
  // line-ending normalization or LFS, those two never match. Reading from
  // HEAD via rev-parse keeps both sides on the same side of git's filter
  // pipeline.
  const localResult = await runGit(
    ["-C", repoRoot, "rev-parse", `HEAD:${relPath}`],
    "revParseHead",
  );
  if (!localResult.ok) return false;
  const localHash = localResult.stdout.trim();

  // Try origin/HEAD, then origin/main, then origin/master
  for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
    const remoteResult = await runGit(["-C", repoRoot, "ls-tree", ref, "--", relPath], "lsTree");
    if (!remoteResult.ok) continue;

    const line = remoteResult.stdout.trim();
    if (!line) continue;

    // Format: <mode> <type> <hash>\t<path>
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;

    const remoteHash = parts[2];
    return localHash === remoteHash;
  }

  return false;
}
