/**
 * Git fast-path for source-repo enumeration. When a repo's working tree is
 * clean, `git ls-tree -r HEAD` gives us (path, blob_oid) for every tracked
 * file in one call — and git's blob SHA-1 *is* a content hash, so we can
 * skip the formatter + SHA-256 work entirely for unchanged files.
 *
 * On a dirty working tree we report `clean: false` and the caller falls back
 * to the filesystem walker.
 */

import { runGit } from "../index/commits";

export interface GitTreeEntry {
  /** Repo-relative POSIX path. */
  path: string;
  /** Git blob SHA-1 — usable directly as a content hash. */
  blobOid: string;
}

export interface GitTreeResult {
  /** True if the working tree is clean (no modified, added, deleted, or untracked files). */
  clean: boolean;
  entries: GitTreeEntry[];
}

/**
 * Enumerate tracked files at HEAD via git plumbing. Returns clean=false if the
 * repo isn't in a state where blob OIDs are trustworthy as content hashes
 * (uncommitted changes, untracked files, or git failures).
 */
export async function gitLsTreeHead(repoRoot: string): Promise<GitTreeResult> {
  // Cheap dirty-check first — bail fast if we can't trust the index.
  const status = await runGit(["-C", repoRoot, "status", "--porcelain"], "ls-tree.status");
  if (!status.ok) return { clean: false, entries: [] };
  if (status.stdout.trim().length > 0) {
    return { clean: false, entries: [] };
  }

  const ls = await runGit(["-C", repoRoot, "ls-tree", "-r", "HEAD"], "ls-tree.head");
  if (!ls.ok) return { clean: false, entries: [] };

  const entries: GitTreeEntry[] = [];
  for (const line of ls.stdout.split("\n")) {
    if (!line) continue;
    // Format: "<mode> blob <oid>\t<path>"
    const tabIdx = line.indexOf("\t");
    if (tabIdx < 0) continue;
    const meta = line.slice(0, tabIdx).split(/\s+/);
    if (meta.length < 3 || meta[1] !== "blob") continue;
    entries.push({ path: line.slice(tabIdx + 1), blobOid: meta[2] });
  }

  return { clean: true, entries };
}
