# Implementation Plan: codeindex

## Context

We're building a local semantic index for codebases that augments Claude Code's Glob/Grep/Read tools with embedding-based search. The design is informed by OpenViking (AST skeletons, bottom-up directory summaries, score propagation), Augment Context Services (single retrieval tool for agents), sigma-ralph-grindset (`claude --print` as LLM backend), and db-harness (Bun-native dual-database skill pattern).

**Spec**: `/Users/russfugal/repo/codeindex/SPEC.md`

---

## Implementation Order (18 atomic commits)

### Phase 1: Foundation (sequential, single agent)

| # | Commit | Files | Notes |
|---|--------|-------|-------|
| 1 | Project scaffolding | `package.json`, `tsconfig.json` | Bun project, `web-tree-sitter` + `openai` + `ignore` deps. Use `web-tree-sitter` (WASM) because native `tree-sitter` N-API has known Bun gaps. |
| 2 | Type definitions | `src/search/types.ts` | All interfaces: `SearchResult`, `SearchOptions`, `CodeindexConfig`, `ScoringConfig`, `RepoRecord`, `FileRecord`, `DirectoryRecord`, `CommitRecord`, `FileCommitLink` |
| 3 | Config module | `src/config.ts` | Load `~/.config/codeindex/config.json` + `.codeindex.json`, merge with defaults. Formatter auto-detection via `Bun.file().exists()` checks in priority order. |
| 4 | PostgreSQL connection | `src/db/pg.ts` | `import { SQL } from "bun"` + `new SQL({hostname, port, database, username, max})` — exact db-harness pattern from `/Users/russfugal/ObsidianVault/tPoSO/db-harness/src/pg.ts` |
| 5 | SQLite connection | `src/db/sqlite.ts` | **Must use `import { Database } from "bun:sqlite"`** (not `SQL` from `"bun"`) because we need `db.loadExtension()` for sqlite-vec. The `SQL` class doesn't expose loadExtension. Wrap sync calls in `Promise.resolve()` for API parity with pg. Provide `.unsafe(sql, params)` matching db-harness `enl.unsafe()` pattern. |
| 6 | Schema creation | `src/db/schema.ts` | `ensurePgSchema()`: CREATE EXTENSION vector + all 5 tables with `vector(1536)` columns. `ensureSqliteSchema()`: all 5 tables + `vec0` virtual tables for embeddings (sqlite-vec stores vectors in separate virtual tables joined by ID). |

### Phase 2: Indexing pipeline (parallel after foundation)

| # | Commit | Files | Teammate | Notes |
|---|--------|-------|----------|-------|
| 7 | File walker | `src/index/walker.ts`, `.indexignore.example` | walker-agent | `ignore` npm package for .gitignore/.indexignore. `walkRepo()` async generator yields relative paths. |
| 8 | AST skeleton extraction | `src/index/skeleton.ts`, `scripts/fetch-grammars.ts` | skeleton-agent | Port OpenViking's per-language extractors (see `https://github.com/volcengine/OpenViking/tree/main/openviking/parse/parsers/code/ast`) to TS. `web-tree-sitter` WASM init via `Parser.init()`. Grammars from `tree-sitter-wasms` npm package or built via `tree-sitter build --wasm`. Extension map: `.ts`→typescript, `.tsx`→tsx, `.js`/`.jsx`→javascript, `.py`→python, `.rs`→rust, `.go`→go, `.java`→java, `.c`→c, `.cpp`/`.h`/`.hpp`→cpp, `.cs`→c_sharp. Non-code fallback: first N lines. |
| 9 | Formatter piping | `src/index/formatter.ts` | formatter-agent | `Bun.spawn(cmd.split(" "), { stdin: new Response(content) })` to pipe file through formatter in memory, then `new Bun.CryptoHasher("sha256")` for hash. Never writes to disk. |
| 10 | Embedding module | `src/index/embedder.ts` | embedder-agent | OpenAI SDK: `client.embeddings.create({ model, input, dimensions })`. Batch support (up to 2048 inputs). Retry with exponential backoff for rate limits. |
| 11 | Git commit extraction | `src/index/commits.ts` | commits-agent | `Bun.spawn(["git", "log", ...])` for per-file commit history + messages. Also: `getRepoOrigin()`, `getRepoName()`, `getChangedFiles()`. |
| 12 | Directory summaries | `src/index/directories.ts` | directories-agent | **Blocked on 7-11.** Bottom-up DAG: leaf dirs first, parents next. Two embeddings per dir: (a) concat of immediate child skeletons (non-recursive), (b) `claude --print --model haiku --output-format json --json-schema '...'` summary of concat + extracted docs + recursive child summaries. Spawn pattern from sigma-ralph-grindset lines 422-446: `Bun.spawn(["claude","--print","--model","haiku",...], { stdin: new Response(prompt), stdout: "pipe", env: {...process.env, CLAUDECODE: ""} })`. Graceful fallback if `claude` CLI unavailable (leave summary null). |

### Phase 3: Surface layer (parallel after indexing)

| # | Commit | Files | Teammate | Notes |
|---|--------|-------|----------|-------|
| 13 | Search query engine | `src/search/query.ts` | search-agent | Scoring algorithm from spec. pg uses `<=>` operator via `pg.unsafe()` with `$1::vector`. SQLite uses `vec_distance_cosine()` JOIN against vec0 virtual table. Returns all results >= minScore, optional topN cap. |
| 14 | Git hook installer | `src/hooks/post-commit.ts` | hooks-agent | Writes `.git/hooks/post-commit`, chmod +x. Appends if existing hook present. |
| 15 | pg→sqlite export | `src/db/export.ts` | export-agent | Read all rows for repoId from pg, insert into new SQLite db. Convert vector arrays to sqlite-vec format. |
| 16 | CLI entry point | `src/index.ts` | cli-agent | **Blocked on 13.** `#!/usr/bin/env bun` shebang. `process.argv` dispatch (no CLI framework). Commands: reindex, update, search, export, install-hook, config, status. Each handler orchestrates pipeline modules. Pattern: db-harness `src/index.ts` unified export object. |

---

## Agent Team Strategy

### Team 1: `codeindex-foundation` (before commit 1)

```
Create an agent team for the codeindex project foundation.
One teammate builds the project scaffolding, types, config, and database layers
sequentially (commits 1-6). Each commit is atomic. Follow the Bun SQL patterns
from /Users/russfugal/ObsidianVault/tPoSO/db-harness/src/ exactly.
The spec is at /Users/russfugal/repo/codeindex/SPEC.md.
Use Sonnet for the teammate.
```

**Coordination**: Single agent, sequential. Must complete before Team 2 starts.

### Team 2: `codeindex-indexing` (after commit 6 lands)

```
Create an agent team for the codeindex indexing pipeline. 5 parallel teammates:
- walker-agent: file tree walker with gitignore/indexignore support (commit 7)
- skeleton-agent: tree-sitter WASM AST skeleton extraction (commit 8)
- formatter-agent: format-in-memory and hash (commit 9)
- embedder-agent: OpenAI text-embedding-3-small (commit 10)
- commits-agent: git commit history extraction (commit 11)
After all 5 complete, I will build directories.ts (commit 12) which depends on all of them.
The spec is at /Users/russfugal/repo/codeindex/SPEC.md.
Use Sonnet for each teammate.
```

**Coordination**: 5-way parallel for commits 7-11. Lead builds commit 12 after all land (it imports from all 5 modules).

### Team 3: `codeindex-surface` (after commit 12 lands)

```
Create an agent team for the codeindex surface layer. 3 parallel teammates:
- search-agent: search/query.ts scoring engine with pgvector and sqlite-vec (commit 13)
- hooks-agent: git post-commit hook installer (commit 14)
- export-agent: pg-to-sqlite export (commit 15)
After search-agent completes, I will build the CLI entry point (commit 16).
The spec is at /Users/russfugal/repo/codeindex/SPEC.md.
Use Sonnet for each teammate.
```

**Coordination**: 3-way parallel for commits 13-15. Lead builds commit 16 after 13 lands.

---

## Key Patterns to Reuse

| Pattern | Source | Files |
|---------|--------|-------|
| Bun SQL PostgreSQL | db-harness | `/Users/russfugal/ObsidianVault/tPoSO/db-harness/src/pg.ts`, `config.ts` |
| Bun SQL tagged templates + `unsafe()` | db-harness | `/Users/russfugal/ObsidianVault/tPoSO/db-harness/src/articles.ts`, `neighbors.ts` |
| Unified `db` export object | db-harness | `/Users/russfugal/ObsidianVault/tPoSO/db-harness/src/index.ts` |
| `claude --print` spawn | sigma-ralph-grindset | `/Users/russfugal/repo/sigma-ralph-grindset/src/audit/cli-backend.ts:422-446` |
| JSON schema enforcement | sigma-ralph-grindset | `/Users/russfugal/repo/sigma-ralph-grindset/src/audit/schema.ts` |
| AST extraction per language | OpenViking | `https://github.com/volcengine/OpenViking/tree/main/openviking/parse/parsers/code/ast` |
| Bottom-up directory DAG | OpenViking | `https://github.com/volcengine/OpenViking/blob/main/openviking/storage/queuefs/semantic_dag.py` |

---

## Known Risks

1. **sqlite-vec + Bun**: `bun:sqlite` Database supports `loadExtension()`, but macOS system SQLite may not support extensions. May need `Database.setCustomSQLite()` pointing to Homebrew SQLite, or the `sqlite-vec` npm package may bundle its own. Test early in commit 5.
2. **web-tree-sitter WASM in Bun**: `Parser.init()` may need explicit `locateFile` callback. Test early in commit 8.
3. **pgvector `<=>` in tagged templates**: Must use `pg.unsafe()` (not tagged template) for queries with the `<=>` operator since it contains `<`/`>`. db-harness already demonstrates this working.
4. **claude CLI availability**: `directories.ts` gracefully falls back to null summary if `claude` not installed/authenticated.

---

## Verification

After all 16 commits land:

1. **Setup**: `bun install` in `/Users/russfugal/repo/codeindex/`
2. **PostgreSQL**: `createdb codeindex && psql -d codeindex -c "CREATE EXTENSION IF NOT EXISTS vector"`
3. **Full reindex**: `bun src/index.ts reindex --path /Users/russfugal/repo/codeindex` (index self)
4. **Search**: `bun src/index.ts search "AST skeleton extraction" --pretty`
   - Should return `src/index/skeleton.ts` with high score
   - Should return `src/index/directories.ts` (uses skeletons)
   - Commit results should surface commits mentioning "skeleton"
5. **Cross-repo**: `bun src/index.ts reindex --path /Users/russfugal/repo/sigma-ralph-grindset`, then `bun src/index.ts search "audit code" --scope all` — should return results from both repos with `inProject: false` for sigma-ralph-grindset
6. **Export**: `bun src/index.ts export --out test.db` — verify SQLite file created with data
7. **Hook**: `bun src/index.ts install-hook` in a test repo, make a commit, verify index updated
8. **Status**: `bun src/index.ts status` — shows file count, last indexed time
