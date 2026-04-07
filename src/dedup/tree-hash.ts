/**
 * Tree hash: a deterministic Merkle-style root over a sorted list of
 * (relpath, content_hash) pairs. Two package directories with byte-identical
 * contents produce the same tree hash regardless of filesystem walk order.
 *
 * The tree hash is the dedup key for an entire package — a hit lets us skip
 * the whole directory without re-reading any files.
 */

import { createHash } from "crypto";

export interface TreeHashEntry {
  relpath: string;
  contentHash: string;
}

/**
 * Compute the tree hash. Pure function. Sorts entries by relpath, then folds
 * each `${relpath}\0${contentHash}\n` into a SHA-256.
 *
 * The NUL separator prevents path/hash boundary collisions; the trailing
 * newline prevents adjacent-entry boundary collisions.
 */
export function treeHash(entries: TreeHashEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0,
  );
  const hasher = createHash("sha256");
  for (const e of sorted) {
    hasher.update(e.relpath);
    hasher.update("\0");
    hasher.update(e.contentHash);
    hasher.update("\n");
  }
  return hasher.digest("hex");
}
