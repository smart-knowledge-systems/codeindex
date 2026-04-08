# Dependency Deduplication

Codeindex caches every file embedding it produces in a **global dedup store**
that lives outside any single repo. The cache is keyed by content hash plus
embedding configuration `(provider, model, dimensions)`, so any two repos
on the same machine that contain byte-identical files reuse the same
embedding without re-calling the embedding API.

For developers working across many repos that share dependencies, this
collapses the cost of indexing repo #2 (and #3, #4, ...) to near zero for
everything those repos have in common — including identical source files,
copy-pasted utility code, and especially shared `node_modules` packages.

> **Privacy boundary.** The local dedup store is local-only. Nothing
> leaves your machine. Cloud-backed dedup (cross-user sharing of public
> repo embeddings) is a separate, opt-in feature that ships with cidx-cloud
> and is **not** part of the local store described here.

---

## Quick start

The first reindex after upgrading prompts you to pick a backend:

```text
Dependency dedup is available. The global store caches embeddings across
every repo on this machine — indexing repo #2 that shares deps with
repo #1 costs ~zero embedding spend.

  [p] Postgres   (recommended if you already use the pg backend)
  [s] SQLite     (local-first, zero-config, ~/.codeindex/global.db)
  [d] Disable    (skip dedup entirely)

Choose [p/s/d] (default s):
```

Pick whichever matches your existing per-repo store. The choice persists in
`~/.config/codeindex/config.json` and never asks again. Non-interactive
sessions silently default to SQLite.

That's it. Subsequent reindexes will surface a hit/miss line at the end of
the run:

```text
Dedup:  812 hits / 47 misses (94.5% hit rate, ~$0.0042 saved)
```

---

## What gets deduplicated

| Tier | Dedup key | When it kicks in |
|---|---|---|
| **File** | `(content_hash, provider, model, dimensions)` | Always — every file indexed by `reindex` or `update`. Shared automatically across all per-repo stores. |
| **Package** | `(tree_hash, provider, model, dimensions)` for installed dep packages | Opt-in via `dedup.indexDependencies: true`. Detects npm, Cargo, Go modcache, and Python site-packages package boundaries. |

The file tier is on whenever dedup is enabled. The package tier is
**off by default** because walking `node_modules` is expensive on first
encounter; enable it explicitly when you want the cross-version dep
short-circuit.

### Cross-version dedup

`lodash@4.17.20` and `lodash@4.17.21` share the vast majority of their
files byte-for-byte. The hybrid file+package design handles this for
free: a tree-hash mismatch means we walk the new version, but every
unchanged file inside it is a file-tier cache hit. A patch-version bump
costs `O(changed files)`, not `O(all files)`.

### The git-blob-OID fast path

When a source repo is in a clean working tree, codeindex enumerates files
via `git ls-tree -r HEAD` instead of the filesystem walker. Git's blob
SHA-1 *is* a content hash, so files unchanged since the last reindex skip
the disk read entirely — no formatter, no parser, no embedder. Dirty
working trees fall back to the filesystem walker transparently.

---

## CLI

### `codeindex dedup stats [--json]`

Inspect the global store: blob count, package count, repo→package link
count, on-disk size (SQLite only), per-ecosystem package breakdown, and
per-(provider, model, dimensions) blob count. Read-only.

### `codeindex dedup gc [--dry-run] [--json]`

Sweep unreferenced state from the store. Two tiers:

1. **Packages**: any `packages` row with no `repo_packages` link is
   removed. Cascades to `package_files` via FK.
2. **Blobs**: the live hash set is the union of (a) hashes referenced by
   surviving packages and (b) hashes referenced by every registered
   repo's per-repo `files` table. Any blob whose hash is not in the live
   set is deleted.

`--dry-run` reports what would be deleted without writing. Use it before
running the real sweep on a long-lived store.

### `codeindex repo remove <name>`

Removing a repo automatically drops its `repo_packages` link rows from
the global store. The next `dedup gc` sweep will reclaim packages whose
only references were in the removed repo.

---

## Configuration

`~/.config/codeindex/config.json` holds the global dedup section:

```jsonc
{
  "dedup": {
    "enabled": true,
    "backend": "sqlite",        // "pg" | "sqlite" | null (prompt next time)
    "sqlitePath": null,         // override default ~/.codeindex/global.db
    "indexDependencies": false  // opt-in package-tier walking
  }
}
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | bool | `true` | Master switch. `false` bypasses dedup entirely. |
| `backend` | `"pg" \| "sqlite" \| null` | `null` | `null` triggers the first-use prompt. |
| `sqlitePath` | string | `~/.codeindex/global.db` | SQLite store path override. |
| `indexDependencies` | bool | `false` | Enable the package-tier pre-warm stage. Walks `node_modules` and `vendor/` on every reindex; expensive on first run, free on subsequent runs. |

---

## Privacy

The local store contains skeletons (structural summaries of code) and
embedding vectors. **No raw source code, no secrets.** The skeleton
extractor never includes string literals; it preserves only the public
shape of declarations (functions, classes, imports, types). The same
secret-scan that protects per-repo writes also protects what's eligible
to be written to the global store.

The store is plain SQLite (or Postgres) and lives wholly under your
control. Delete `~/.codeindex/global.db` at any time to reset.

---

## Cloud mode (forthcoming)

A future cidx-cloud integration will let users opt-in to a *shared*
global store for **public** repositories and **registry-backed**
dependency packages. When enabled:

- Indexing a public repo at a known commit gets near-zero embedding
  spend on first encounter — the cloud already has the blobs.
- Indexing a public dep package (lodash, serde, requests, ...) hits the
  same shared pool, so every cidx-cloud user shares one canonical
  embedding set per package version.

Private repos and patched local packages stay local-only and never get
promoted to the cloud pool. Eligibility is enforced both client-side and
server-side via provenance verification (unauthenticated `git ls-remote`
for git, registry manifest hashes for packages). Details land alongside
the cidx-cloud Phase 2 work — see `docs/dev-log/plan-dependency-dedup-phase2.md`.
