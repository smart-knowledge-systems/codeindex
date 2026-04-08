# Dependency Deduplication

Codeindex caches every file embedding it produces in a **global dedup store**
that lives outside any single repo. The cache is keyed by content hash plus
embedding configuration `(provider, model, dimensions)`, so any two repos
indexed against the same store that contain byte-identical files reuse the
same embedding without re-calling the embedding API.

For developers working across many repos that share dependencies, this
collapses the cost of indexing repo #2 (and #3, #4, …) to near zero for
everything those repos have in common — identical source files, copy-pasted
utility code, and especially shared `node_modules`, `vendor/`, `~/.cargo`,
and `site-packages` package trees.

> **Privacy boundary.** The global dedup store described here is local to
> whatever database you point it at — your laptop's SQLite file, or your
> team's Postgres. Nothing is sent anywhere else. Cloud-backed dedup
> (cross-user sharing of public-repo embeddings) is a separate, opt-in
> feature that ships with cidx-cloud and is **not** part of the store
> described below.

---

## Choosing a backend

Codeindex supports two backends for the global dedup store:

| Backend | Where it lives | Best for |
|---|---|---|
| **Postgres** *(recommended)* | Same PG instance as your per-repo index, in the unified `file_blobs` / `repo_files` tables (plus `packages` / `package_files` / `repo_packages` for the package tier) | Anyone already running the PG per-repo backend; teams; multi-machine / CI setups |
| **SQLite** | `~/.codeindex/global.db` (single file) | Single-developer, single-machine, zero-config |

### What dedup saves

The global dedup store is the canonical home for every embedding
codeindex produces, keyed by `(content_hash, provider, model,
dimensions)`. On Postgres, the `file_blobs` table holds one row per
unique blob and a `repo_files` junction maps each per-repo path to its
blob. Two repos containing a byte-identical `lodash/isEqual.js` end up
with **one** `file_blobs` row plus two cheap junction entries — no
duplicated vectors at rest, and the HNSW vector index lives on the
deduped blob set so it shrinks roughly with `unique_blobs / total_files`.

This collapses two costs at once:

- **Embedding API spend.** Indexing repo #2 reuses the cached vector
  for every file it shares with repo #1, instead of paying the
  provider again. Hit rates of 90%+ are typical across a developer's
  active project set.
- **On-disk vector storage and HNSW index memory.** Because the
  embedding lives in `file_blobs` rather than per-repo `files`,
  duplicated source files no longer carry duplicated vector copies.
  For a developer with ~10 Node projects, this is roughly a 1.2 GB
  reduction in indexed-vector bytes plus a proportional shrink in
  HNSW index memory.

Per-repo `files` rows are still populated (so the `codeindex export`
re-denormalization path can produce a portable read-only snapshot),
but at search time the junction path is the source of truth and the
legacy `files` table is unused for retrieval.

### Why Postgres is usually the right choice

Postgres is recommended for most users who have the option:

1. **Team & multi-machine sharing.** A Postgres dedup store can be pointed
   at by several developer workstations and CI runners simultaneously. The
   first person to index `lodash@4.17.21` does the work; everyone else on
   the team gets a 100% hit rate for free. SQLite is single-machine — the
   cache only helps the laptop that built it.
2. **Single backend, single operational surface.** If your per-repo store
   is already Postgres, adding dedup to the same instance means you run
   one database, back up one database, and tune one database. No second
   product to keep alive.
3. **Concurrent reindexes.** Postgres handles multiple codeindex processes
   writing simultaneously (parallel `reindex --scope all` across repos, CI
   pipelines, etc.). SQLite serializes writers via its WAL lock, which is
   fine on a single machine but becomes a bottleneck under heavy
   parallelism.
4. **Row-level dedup of embeddings.** The unified `file_blobs` schema
   only ships in the PG backend today; the SQLite global store still
   uses the legacy `content_blobs` table and pays the per-repo
   duplication cost on disk. SQLite machine-wide row-level dedup is a
   planned follow-up.
5. **Better Postgres-native data types.** Embeddings are stored in a
   `vector` column via `pgvector`, matching the per-repo store's format
   exactly. SQLite stores them as blobs and parses on read.

### When SQLite is the right choice

- You're a solo developer working on one machine.
- You don't already run Postgres and don't want to.
- You want a zero-config, single-file store you can `rm` to reset.

You can always start on SQLite and [migrate to Postgres later](#migration-paths)
without losing anything important.

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

The choice persists in `~/.config/codeindex/config.json` and never asks
again. Non-interactive sessions silently default to SQLite.

Subsequent reindexes show a hit/miss line at the end of the run:

```text
Dedup:  812 hits / 47 misses (94.5% hit rate, ~$0.0042 saved)
```

---

## What gets deduplicated

| Tier | Dedup key | When it kicks in |
|---|---|---|
| **File** | `(content_hash, provider, model, dimensions)` | Always — every file indexed by `reindex` or `update`. |
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

```text
$ codeindex dedup stats
Backend:       postgres
Blobs:         48,213   (openai/text-embedding-3-small/1536)
Packages:      1,284    (npm: 1,102 · cargo: 98 · pypi: 67 · gomod: 17)
Repo links:    37
Storage:       n/a (postgres)
```

### `codeindex dedup gc [--dry-run] [--json]`

Sweep unreferenced state from the store. Two tiers:

1. **Packages**: any `packages` row with no `repo_packages` link is
   removed. Cascades to `package_files` via FK.
2. **Blobs**: on the PG backend, a single `NOT EXISTS` sweep deletes
   `file_blobs` rows that no `repo_files` row and no `package_files`
   row references. On the SQLite backend (which still uses the legacy
   `content_blobs` table), gc falls back to a live-set protocol that
   walks every registered repo's per-repo `files` table.

`--dry-run` reports what would be deleted without writing. Always run it
first on a long-lived store.

### `codeindex repo remove <name>`

Removing a repo automatically drops its `repo_packages` link rows from
the global store. The next `dedup gc` sweep will reclaim packages whose
only references were in the removed repo.

---

## Configuration

`~/.config/codeindex/config.json` holds the global dedup section:

```jsonc
{
  // ... per-repo pg section already here if you use the pg backend:
  "pg": {
    "host": "localhost",
    "port": 5432,
    "database": "codeindex",
    "user": "codeindex"
  },

  "dedup": {
    "enabled": true,
    "backend": "pg",           // "pg" | "sqlite" | null (prompt next time)
    "sqlitePath": null,        // override default ~/.codeindex/global.db
    "indexDependencies": false // opt-in package-tier walking
  }
}
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | bool | `true` | Master switch. `false` bypasses dedup entirely. |
| `backend` | `"pg" \| "sqlite" \| null` | `null` | `null` triggers the first-use prompt. |
| `sqlitePath` | string | `~/.codeindex/global.db` | SQLite store path override. |
| `indexDependencies` | bool | `false` | Enable the package-tier pre-warm stage. Walks `node_modules` and `vendor/` on every reindex; expensive on first run, free on subsequent runs. |

When `backend: "pg"`, the dedup store reuses the `pg.*` connection
settings from the same config file — it does **not** need a separate
connection string. Schema is versioned independently from the per-repo
schema and is auto-applied on first connect.

---

## Migration paths

Schema migrations run automatically the first time each backend is
opened, so switching backends is mostly a config change followed by a
reindex. The one thing a backend switch does **not** preserve is the
previously cached embeddings — the new backend starts empty and has to
rebuild its cache on the next reindex. In practice this means the first
reindex after the switch costs normal embedding spend, and every
subsequent reindex is back to near-zero.

### 1. Dedup disabled, per-repo SQLite → dedup on Postgres

You have `.codeindex.db` files per repo, no global dedup store yet, and
want to move to a Postgres-backed global dedup store (either co-located
with an existing PG per-repo store or a freshly-provisioned PG).

**Option A — keep the per-repo SQLite stores**. The global dedup store
and the per-repo store are independent; you can run PG dedup with SQLite
per-repo indexes. Configure PG connection details and flip dedup on:

```bash
# 1. Ensure PG is reachable and you have credentials.
psql -h localhost -U codeindex -d codeindex -c 'select 1'

# 2. Edit ~/.config/codeindex/config.json: add the pg block and enable dedup.
#    (Replace values with your PG coordinates.)
cat > ~/.config/codeindex/config.json <<'JSON'
{
  "pg": {
    "host": "localhost",
    "port": 5432,
    "database": "codeindex",
    "user": "codeindex"
  },
  "dedup": {
    "enabled": true,
    "backend": "pg"
  }
}
JSON

# 3. Reindex one repo. Global-store migrations auto-apply on first open.
cd path/to/repo
codeindex reindex

# 4. Verify.
codeindex dedup stats
```

The first reindex pays normal embedding cost. The second repo (and every
reindex after that) benefits from the file- and package-level cache.

**Option B — move per-repo indexes to PG too** (recommended long-term).
This is the "unified backend" setup. Run `codeindex setup --store pg` in
each repo, which migrates the per-repo index into PG, then enable dedup
as above. You end up with one database holding both the per-repo indexes
and the global dedup store.

### 2. Dedup disabled on Postgres → dedup on Postgres *(you are here)*

You already run PG for per-repo indexes (`pg.*` is already in your
config) but haven't enabled dedup. This is the simplest path:

```bash
# 1. Enable dedup and select the pg backend.
codeindex config set dedup.enabled true
codeindex config set dedup.backend pg

# (Or edit ~/.config/codeindex/config.json directly — add:
#    "dedup": { "enabled": true, "backend": "pg" }
#  alongside your existing "pg" block.)

# 2. Reindex. The global dedup schema auto-applies on first open.
codeindex reindex

# 3. Verify.
codeindex dedup stats
```

That's it — no data movement, no schema coordination, no restart. The
global dedup tables live in the same PG database as your per-repo tables
and are versioned independently.

To also enable cross-version package dedup (one-time extra walk of
`node_modules` / `vendor/`):

```bash
codeindex config set dedup.indexDependencies true
codeindex reindex
```

### 3. SQLite dedup → Postgres dedup

You've been running `~/.codeindex/global.db` and want to promote to
Postgres (usually because you're onboarding a teammate, a CI runner, or a
second workstation and want to share the cache).

There is no automated `migrate` command for the global store today —
the cache is lossless to rebuild, so the recommended path is:

```bash
# 1. Ensure PG is set up (see "Option B" above if per-repo is still sqlite).

# 2. Flip dedup backend to pg.
codeindex config set dedup.backend pg

# 3. Rebuild the cache on the first machine.
codeindex reindex --scope all

# 4. (Optional) Archive the old SQLite cache in case you want to roll back.
mv ~/.codeindex/global.db ~/.codeindex/global.db.sqlite-backup
```

Every other machine / CI runner that points its `pg.*` config at the
same instance immediately sees the populated cache and benefits from
hit-rate parity without re-embedding anything.

If you really want to carry the existing SQLite cache over rather than
re-embed, you can do a one-shot dump:

```bash
# Dump content_blobs, packages, package_files, repo_packages from sqlite
# to CSV, then COPY into the matching pg tables. Schemas are kept in
# lock-step across backends (see migrations/global/*).
sqlite3 ~/.codeindex/global.db <<'SQL' > /tmp/content_blobs.csv
.mode csv
SELECT content_hash, provider, model, dimensions,
       skeleton, skeleton_entries, embedding
FROM content_blobs;
SQL

psql "$PG_URL" -c "\\copy content_blobs(content_hash, provider, model, dimensions, skeleton, skeleton_entries, embedding) FROM '/tmp/content_blobs.csv' WITH CSV"

# Repeat for packages, package_files, repo_packages.
```

This is an unsupported escape hatch — the embedding column format has
to be converted from SQLite blob to pgvector text literal, which is
awkward enough that we recommend just re-embedding.

### 4. Upgrading a 0009-era PG store into 0010 (content-addressed)

If your Postgres per-repo store was last touched on a codeindex build
before migration `0010_content_addressed_files`, opening it with the
current binary will:

1. Auto-apply migration 0010, creating `file_blobs` and `repo_files`
   alongside the legacy `files` table.
2. Auto-apply global migration 0002, dropping the old `content_blobs`
   table that the global dedup store used to live in (the unified
   `file_blobs` table is now its home).

Both migrations are additive / FK-safe and run inside a single
transaction per migration, so an interrupted upgrade leaves the store
in a consistent state. **No manual data movement is needed.** However,
existing rows in the legacy `files` table are **not** backfilled into
`file_blobs` automatically — the next `codeindex reindex` populates
both tables via dual-write, and from that point on the junction search
path returns results.

Recommended upgrade sequence:

```bash
# 1. Pull the new codeindex binary; do not reindex yet.
git pull && bun install

# 2. Run a tiny no-op command that opens the store so migrations apply.
codeindex dedup stats

# 3. Reindex one repo to populate file_blobs / repo_files for it.
cd path/to/repo
codeindex reindex

# 4. Spot-check that the junction search path returns results.
codeindex search 'some query you know works'
```

Repos that have not yet been reindexed against the new schema will
return empty result sets from the junction path until they are. The
legacy `files` table is still populated by reindex (via dual-write) so
the export round-trip path keeps working throughout the rollover.

---

## Bundling a read-only index with a repo

This is separate from the global dedup store but frequently confused
with it: if you want to **ship a pre-built, redistributable copy of a
repo's index** (so a collaborator or CI job can run `codeindex search`
without re-indexing), use `codeindex export`.

```bash
# From a repo whose per-repo index lives in PG, write a portable .codeindex.db
# SQLite file that you can commit to the repo or attach to a release.
codeindex export --out .codeindex.db

# Include embeddings (off by default because embeddings are large and
# provider-specific):
codeindex export --out .codeindex.db --include-embeddings

# Exclude paths by glob (honors .indexignore too):
codeindex export --out .codeindex.db --exclude 'test/fixtures/**,build/**'

# Strip commit metadata from the export:
codeindex export --out .codeindex.db --redact-commits
```

The export is a **point-in-time snapshot** of one repo's index sourced
from your Postgres per-repo store. It is not the global dedup store and
it is not a two-way sync — consumers of the exported SQLite file get a
read-only index they can search immediately.

The export format is intentionally a **re-denormalized** view of the
content-addressed live schema: rows are joined back through
`file_blobs` ↔ `repo_files` and written into a flat `files`-shaped
SQLite table so the export remains stable for downstream consumers
(cidx-cloud ingest, IDE plugins, tooling pinned to the older shape).
The export also includes a `_metadata(key, value)` table stamped with
`schema_version = 1` so future format bumps can be detected.

Why this matters for dedup: running the global dedup store on Postgres
is precisely what gives `codeindex export` its fast path. Snapshots of
heavily-shared repos materialize from one canonical `file_blobs` row
per unique vector, so re-emitting the denormalized export form is
cheap even when the snapshotted repo carries thousands of dependency
files. If you need to publish index snapshots regularly (nightly,
per-release), the PG + dedup combination minimizes rebuild cost and
then `export` turns the result into a distributable file.

---

## Privacy

The local store contains skeletons (structural summaries of code) and
embedding vectors. **No raw source code, no secrets.** The skeleton
extractor never includes string literals; it preserves only the public
shape of declarations (functions, classes, imports, types). The same
secret-scan that protects per-repo writes also protects what's eligible
to be written to the global store.

The store lives wholly under your control:

- **SQLite**: delete `~/.codeindex/global.db` at any time to reset.
- **Postgres**: `DROP` the `file_blobs`, `repo_files`, `packages`,
  `package_files`, and `repo_packages` tables. They will be recreated
  by the migration runner on the next reindex.

---

## Cloud mode (forthcoming)

A future cidx-cloud integration will let users opt-in to a *shared*
global store for **public** repositories and **registry-backed**
dependency packages. When enabled:

- Indexing a public repo at a known commit gets near-zero embedding
  spend on first encounter — the cloud already has the blobs.
- Indexing a public dep package (lodash, serde, requests, …) hits the
  same shared pool, so every cidx-cloud user shares one canonical
  embedding set per package version.

Private repos and patched local packages stay local-only and never get
promoted to the cloud pool. Eligibility is enforced both client-side and
server-side via provenance verification (unauthenticated `git ls-remote`
for git, registry manifest hashes for packages). Details land alongside
the cidx-cloud Phase 2 work — see `docs/dev-log/plan-dependency-dedup-phase2.md`.
