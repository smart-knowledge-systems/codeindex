# Plan: Drop the Legacy `files` Table (Phase 3 Dedup, Stage 1.10)

## Context

PR smart-knowledge-systems/codeindex#21 (feat/dependency-dedup-phase2) landed
the content-addressed `file_blobs` + `repo_files` schema with
`useBlobSchema` defaulting to `true`. Search, xref, export, and gc all
route through the junction schema. **But the legacy `files` table is
still populated on every reindex and is still the FK target for three
join tables.** That's what keeps ~1.2 GB of redundant per-repo vectors
alive on a node_modules-heavy developer machine. This plan is what
actually reclaims the disk.

See `docs/dev-log/plan-content-addressed-files.md` "Deferred to
follow-up PRs" section for the history.

## What still references `files.id`

Three tables hold FKs into `files(id)`:

| Table              | Columns                                    | ON DELETE           | Migration                    |
| ------------------ | ------------------------------------------ | ------------------- | ---------------------------- |
| `file_commits`     | `file_id`                                  | (implicit RESTRICT) | `0001_baseline`              |
| `file_imports`     | `source_file_id`, `resolved_file_id`       | CASCADE / SET NULL  | `0004_file_imports`          |
| `cross_repo_edges` | `source_file_id`, `target_file_id`         | CASCADE / SET NULL  | `0006_cross_repo_edges`      |

Plus RLS policies in `0009_rls_phase2.pg.sql` (`repo_scope_file_commits`,
`repo_scope_file_imports`) that `EXISTS` into `files` for scope
enforcement — they need to move to `repo_files`.

On the code side, ~25 files in `src/` reference `files.id` / `FROM
files` / `JOIN files`. After PR #21 most of those are read-only
side-lookups the search + xref + export paths do to resolve numeric
`files.id` for BM25 keying, commit boost joins, and
`cross_repo_edges.target_file_id`. Those all become `repo_files.id`
lookups in this plan.

## The FK-rewiring decision

The natural new row identity is `(repo_id, file_path)`, but making
that the FK target on three junction tables is painful:

- **`file_commits`** grows from 8 bytes (file_id int) per row to
  ~50–200 bytes (int + text path). Multiply by "every file × every
  commit it appears in, up to `commitDepth`" and the table balloons.
- **`file_imports`** doubles the composite everywhere, and the
  `resolved_file_id` SET NULL semantic gets awkward with a composite.
- **`cross_repo_edges`** is cross-repo by definition; a composite
  `(source_repo_id, source_file_path, target_repo_id, target_file_path)`
  is four columns per edge.

So: **keep an integer surrogate, but put it on `repo_files` instead of
`files`.** Concretely:

```sql
ALTER TABLE repo_files ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX repo_files_id_uniq ON repo_files(id);
```

The PK of `repo_files` stays `(repo_id, file_path)` for the natural
access pattern; `id` is a secondary surrogate that only exists to be a
cheap FK target. SQLite gets the same treatment via a
`rowid`-equivalent or explicit `INTEGER` surrogate.

## Migration plan

Stages are sized to ship as either one PR (aggressive) or two PRs
(de-risked — recommended).

### Stage A — add, backfill, dual-write (first PR)

1. **Schema migration `0012_repo_files_surrogate_id`** (PG + SQLite)
   - Add `id` to `repo_files` (bigint identity on PG, integer
     auto-increment on SQLite).
   - Add unique index.
   - Add nullable mirror columns to the three junction tables:
     - `file_commits.repo_file_id`
     - `file_imports.source_repo_file_id`, `file_imports.resolved_repo_file_id`
     - `cross_repo_edges.source_repo_file_id`, `cross_repo_edges.target_repo_file_id`
   - No FKs on the mirror columns yet (nullable, backfill pending).

2. **Backfill migration `0013_backfill_repo_file_refs`**
   - For each of the three tables, populate the mirror column(s) via a
     JOIN through `files` → `repo_files` on
     `(repo_id, file_path)`. Example for `file_commits`:

     ```sql
     UPDATE file_commits fc
        SET repo_file_id = rf.id
       FROM files f
       JOIN repo_files rf
         ON rf.repo_id = f.repo_id
        AND rf.file_path = f.file_path
      WHERE fc.file_id = f.id;
     ```

   - On large instances this may need batching — `WHERE file_id
     BETWEEN ...` over chunks with `COMMIT` between. Worth
     instrumenting with `logEvent({ event: "infra.migration.backfill",
     table, rows })` so ops sees progress.
   - SQLite equivalents use `UPDATE ... FROM` (SQLite 3.33+).
   - **Risk:** backfill wall time on multi-GB instances. Consider
     shipping this as a background migration triggered on first
     `codeindex` invocation post-upgrade, not a blocking
     `applyPgMigrations` step. Reference the existing migration runner
     at `src/db/migrate.ts:168-251` for how `schema_version` is tracked.

3. **Code rewire — dual-write phase.** Every write site that currently
   populates the legacy FK columns also populates the new mirror
   columns in the same transaction. Read sites stay on the legacy
   columns; no read-path switch yet.

   Files to touch (from the Phase-3 grep):

   - `src/pipeline/store.ts` — `file_imports` INSERT (already resolves
     `files.id`; also resolve `repo_files.id` via the same UPSERT
     RETURNING path that already exists for blob_id on SQLite).
   - `src/pipeline/commits.ts` — `file_commits` INSERT.
   - `src/index/cross-repo.ts` — `cross_repo_edges` INSERT.
   - `src/index/directories.ts` — only reads `files.id`, no rewire needed
     here.

4. **Tests.** Add parity tests asserting that for any fixture repo,
   `(fc.file_id, rf.id)` pairs in `file_commits` match the JOIN
   reconstruction, and similarly for `file_imports` and
   `cross_repo_edges`. These are the safety net for Stage B.

**First PR ships here.** `useRepoFileIdFks` config flag default is
still `false`; legacy columns are still the authoritative source. PR
title: `feat(dedup): dual-write repo_files surrogate id to join tables`.

### Stage B — read-switch and drop (second PR, after a bake period)

5. **Code rewire — read-path switch.** Every `files.id` read becomes
   a `repo_files.id` read. Gate behind `config.dedup.useRepoFileIdFks`
   (default `false` while the PR is in flight; flip to `true` in a
   commit near the end).

   Files to touch:

   - `src/search/search-pg.ts` — BM25 keying, commit-boost side query
     (the task #4 completion notes flagged this as "still routes
     through `files.id` side-lookup"; that side-lookup goes away).
   - `src/search/search-sqlite.ts` — same.
   - `src/xref.ts` — the `files` JOIN for numeric ids gets dropped;
     xref reads directly from `repo_files`.
   - `src/db/export.ts` — the re-denormalization JOIN collapses from
     3-way (`files` ⨝ `file_blobs` ⨝ `repo_files`) to 2-way
     (`file_blobs` ⨝ `repo_files`). Export output bytes must stay
     identical; verify with the existing export round-trip test.
   - `src/mcp/tools/files.ts` — file lookups move to `repo_files`.
   - `src/pipeline/prune.ts` — prune by `repo_files` identity.
   - `src/search/rerank.ts` — if it caches by `files.id`, switch.
   - `src/check/policies/skeleton-failures.ts`,
     `src/check/policies/index-freshness.ts` — reporting queries.
   - `src/commands/status.ts`, `src/commands/helpers.ts`,
     `src/commands/manifest.ts`, `src/commands/update.ts` —
     count/report queries.
   - `src/intent.ts`, `src/cloud/migrate.ts`, `src/repo.ts` —
     anything else the grep turned up.

6. **Schema migration `0014_swap_to_repo_file_fks`** (PG + SQLite)
   - Add `NOT NULL` to the new mirror columns (requires all live rows
     backfilled; Stage A + baking period is what guarantees this).
   - Add real FKs: `file_commits.repo_file_id REFERENCES
     repo_files(id) ON DELETE CASCADE`, same for the other two tables
     with appropriate ON DELETE semantics.
   - Drop the old columns (`file_commits.file_id`,
     `file_imports.source_file_id` + `resolved_file_id`,
     `cross_repo_edges.source_file_id` + `target_file_id`).
   - Drop their indexes.

7. **RLS migration `0015_rls_repo_files_joins`** (PG only)
   - Rewrite `repo_scope_file_commits` and `repo_scope_file_imports`
     from `0009_rls_phase2.pg.sql` to `EXISTS` into `repo_files`
     instead of `files`. Direct column lookup is simpler than the
     current `EXISTS (SELECT 1 FROM files f WHERE f.id = ...)`
     pattern — use `(SELECT repo_id FROM repo_files rf WHERE rf.id =
     file_commits.repo_file_id) = ANY(...)` or similar.
   - `codeindex_admin` bypass is unchanged.
   - **Optional for single-machine codeindex per the no-RLS-for-new-tables
     direction from Phase 3**, but recommended for consistency since
     RLS is already live on these join tables.

8. **Schema migration `0016_drop_files`** (PG + SQLite)
   - `DROP TABLE files CASCADE` on PG. Drop the HNSW index on
     `files.embedding`. **This is the step that actually reclaims
     the disk.**
   - SQLite: drop `files` + the `file_embeddings` vec0 virtual table
     (both the scalar shadow and the vec0 module table created at
     runtime).

9. **Pipeline simplification.** `src/pipeline/store.ts` drops its
   legacy `files` INSERT path entirely. The `storeFiles` function
   becomes a write to `file_blobs` + `repo_files` + the three join
   tables with surrogate FKs. The `infra.dedup.dualwrite_failed` log
   event (removed in the task #9 flip) stays gone; there's only one
   write path now.

10. **Flip `useRepoFileIdFks` default to `true`**, then remove the
    flag entirely in the same PR (it existed only to gate the
    read-path switch during rollout).

**Second PR ships here.** PR title: `feat(dedup): drop legacy files
table and reclaim disk`.

## Risks

1. **Long-lived FK backfill.** On a large multi-repo corpus the
   `UPDATE ... FROM files JOIN repo_files` in migration `0013` can be
   slow. Plan: batched backfill + progress logging; consider running
   as a background migration triggered on first post-upgrade
   invocation rather than a blocking `applyPgMigrations` step.
2. **Dual-write window during Stage A.** For the duration of Stage A
   every write touches both the legacy FK column and the new mirror
   column inside the same transaction. Disk overhead is minor
   (per-row int addition) but write latency goes up; measure.
3. **BM25 doc-id change.** The BM25 index is rebuilt per-query (not
   persisted), so swapping the key from `files.id` → `repo_files.id`
   is behaviorally a no-op, but any test that pins BM25 ordering or
   doc-id by numeric value needs updating. Grep for `bm25.scores.get`
   + numeric literal.
4. **Cross-repo edge semantics.** `cross_repo_edges.target_file_id`
   can be NULL (unresolved imports). Target becomes
   `target_repo_file_id NULL REFERENCES repo_files(id) ON DELETE SET
   NULL` — same semantic, new target. Verify the unresolved-import
   code path still nulls correctly.
5. **Export byte stability.** External consumers per `README.md:156-163`
   read the exported `.db`. The re-denormalized format must stay
   identical byte-for-byte; the export round-trip test added in task
   #8 is the guardrail. Run it on a seed fixture before and after
   Stage B step 6.
6. **RLS policy rewrite timing.** Policies in `0015_rls_repo_files_joins`
   must land **before** `0016_drop_files`, otherwise there's a
   migration window where `repo_scope_file_commits` references a
   dropped table. Single PR transaction boundaries handle this on PG;
   SQLite has no RLS so only PG is affected.
7. **Rollback plan.** Stage A is reversible (drop the mirror columns
   + surrogate). Stage B is NOT — once `files` is dropped, the only
   way back is re-running the full reindex. Bake Stage A in main for
   at least one release cycle before shipping Stage B.

## Verification

- `bun run check` clean on every commit.
- `bun test` clean on every commit.
- New tests required:
  - **Stage A parity test.** Index a fixture repo, assert
    `(fc.file_id, fc.repo_file_id)` pairs in `file_commits` match the
    JOIN reconstruction `files.id ↔ repo_files.id`; similarly for
    `file_imports` and `cross_repo_edges`.
  - **Backfill idempotency test.** Run migration `0013` twice, assert
    no changes on the second run (no duplicate updates, no FK
    violations).
  - **Stage B read-parity test.** Before and after the read-path
    switch, run a fixed set of search / xref / export queries and
    assert results are identical. This is the main safety net.
  - **Export round-trip test** (already exists from task #8) — rerun
    after migration `0016` to confirm byte stability of the exported
    `.db` format.
  - **RLS integration test** for the rewritten policies in
    `0015_rls_repo_files_joins`: spawn two concurrent sessions with
    different `app.current_repo_ids`, confirm each sees only their
    own `file_commits` / `file_imports` rows via the new policy path.
- **Manual smoke on a real multi-repo corpus:**
  - Before Stage B migration `0016`: `pg_database_size('codeindex')`
    and `pg_relation_size('files')` + HNSW index size.
  - After migration `0016`: same measurements. Target: disk reduction
    roughly proportional to `(total_files - unique_blobs) / total_files`
    on the corpus. For a Node-heavy developer (~10 Next.js apps) the
    research doc predicts ≥70%; a realistic mixed corpus should see
    ≥50%.
  - Run the retrieval-quality eval before and after Stage B; no
    regression.
- **Dogfood** per CLAUDE.md: reindex the codeindex repo itself after
  Stage A and again after Stage B; use `codeindex search` as the
  primary search tool during implementation.

## Critical files touched

### New migrations
- `migrations/0012_repo_files_surrogate_id.pg.sql`
- `migrations/0012_repo_files_surrogate_id.sqlite.sql`
- `migrations/0013_backfill_repo_file_refs.pg.sql`
- `migrations/0013_backfill_repo_file_refs.sqlite.sql`
- `migrations/0014_swap_to_repo_file_fks.pg.sql`
- `migrations/0014_swap_to_repo_file_fks.sqlite.sql`
- `migrations/0015_rls_repo_files_joins.pg.sql` (PG only, optional
  per no-RLS-for-new-tables direction)
- `migrations/0016_drop_files.pg.sql`
- `migrations/0016_drop_files.sqlite.sql`

### Existing source files (from `files.id` / `FROM files` / `JOIN files` grep)
- `src/pipeline/store.ts`
- `src/pipeline/commits.ts`
- `src/pipeline/prune.ts`
- `src/pipeline/collect.ts`
- `src/index/reindex.ts`
- `src/index/cross-repo.ts`
- `src/index/directories.ts`
- `src/search/search-pg.ts`
- `src/search/search-sqlite.ts`
- `src/search/query.ts`
- `src/search/rerank.ts`
- `src/xref.ts`
- `src/intent.ts`
- `src/repo.ts`
- `src/commands/helpers.ts`
- `src/commands/status.ts`
- `src/commands/manifest.ts`
- `src/commands/update.ts`
- `src/commands/dedup.ts`
- `src/mcp/helpers.ts`
- `src/mcp/tools/files.ts`
- `src/check/policies/skeleton-failures.ts`
- `src/check/policies/index-freshness.ts`
- `src/db/export.ts`
- `src/cloud/migrate.ts`

### Docs to reference (read-only, for context)
- `docs/dev-log/plan-content-addressed-files.md` — Phase 3 plan + completion summary
- `docs/dev-log/plan-dependency-dedup-phase1.md`
- `docs/dev-log/plan-dependency-dedup-phase2.md`
- `docs/dev-log/research-dependency-deduplication.md`
- `docs/dev-log/research-content-addressed-files.md`
- `docs/dedup.md` — user-facing docs (needs no change for this plan,
  but verify migration-path section covers 0011→0016 after Stage B)
- `CLAUDE.md` — bun/bunx, atomic commits, gh auth switch,
  no-commit-to-main, dogfood
- `docs/git-commit-style-guide.md`

## Rollout shape

**Aggressive:** one PR covering both stages. Fastest to reclaim disk,
but the bake window between dual-write and drop is zero, so any
backfill bug is discovered on production data. Not recommended.

**Recommended — two PRs:**

1. **PR A** — Stage A (migrations `0012`, `0013`, pipeline dual-write,
   parity tests). Lands quickly, bakes on `main` for a release cycle.
2. **PR B** — Stage B (code rewire to read from new columns,
   migrations `0014`, `0015`, `0016`, pipeline simplification, flag
   removal). Small, focused, reversible until the final `DROP TABLE`
   commit.

Ballpark total: 400–800 lines of code change + 8 migration files,
spread across two PRs.
</content>
</invoke>