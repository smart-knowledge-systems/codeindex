---
name: codeindex
description: Semantic code search across indexed repositories. Use this skill when you need to find where relevant code lives in a large or unfamiliar codebase — especially when you don't know the right file names, class names, or grep patterns. codeindex searches by meaning, not keywords, so it excels at queries like "where is rate limiting implemented" or "find the database connection pooling logic." Use it before resorting to broad Glob/Grep sweeps. Also use this skill when searching across multiple repositories at once with --scope all.
---

# codeindex

codeindex is a semantic search index for codebases. It embeds file skeletons, directory summaries, and commit messages, then ranks results using cosine similarity with commit-recency and directory-hierarchy boosts.

**`codeindex` (alias: `cidx`) is a first-class shell primitive** — treat it like `grep`, `find`, and `glob`. Invoke the CLI directly via Bash whenever it's the right tool, not just through this skill's wrappers. The skill exists to help you recognize *when* to reach for semantic search; the CLI is the actual interface. `cidx search "query"` in Bash is always valid and usually preferred over indirection. Run `cidx --llm` at any time to get the full, agent-oriented usage doc printed to stdout.

**It is a discovery layer, not a context dump.** Search results are pointers — file paths, scores, and types. Use them to decide where to look, then pull actual content with the Read tool (for file contents), Grep (for keyword search within files), and Glob (for file pattern matching). Use the dedicated Claude Code tools (Read, Grep, Glob) for reading and pattern matching inside files — but for semantic search itself, call the `cidx`/`codeindex` CLI directly via Bash.

## When to use codeindex vs Grep/Glob

| Situation | Tool |
|-----------|------|
| You know a function/class/variable name | Grep |
| You know a file name or pattern | Glob |
| You want to understand *where* something is conceptually | **codeindex** |
| The codebase is large and you're exploring blind | **codeindex** |
| You need to search across multiple repos | **codeindex** `--scope all` |
| You already have codeindex results and need file contents | Read tool (never cat/head/tail) |

## Search workflow

Start coarse, then drill in — this saves tokens and avoids pulling irrelevant context.

```bash
# Step 1: Discover relevant areas (paths + scores only)
codeindex search "authentication middleware"

# Step 2: If you want directory-level context before drilling in
codeindex search "authentication middleware" --include-summary

# Step 3: If you want to see code structure
codeindex search "authentication middleware" --include-skeleton

# Step 4: If you want code snippets with line numbers
codeindex search "authentication middleware" --include-snippet

# Step 5: Read the actual files using the Read tool (never cat/head/tail)
# Example: Read("src/middleware/rateLimiter.ts")

# Step 6: Follow up with Grep tool (never shell grep) for keyword search
# Example: Grep("rateLimiter", path="src/middleware/")
```

### Search flags

- `--min-score <f>` — Filter threshold (default 0.3). Raise to reduce noise, lower to cast a wider net
- `--top-n <n>` — Cap the number of results
- `--scope <s>` — `project` (default), `all` (every indexed repo), or `repo1,repo2`
- `--lang <l>` — Filter by language: `ts`, `python`, `rust`, `go`, `java`, `c`, `cpp`, `cs` (comma-separated)
- `--dir <d>` — Filter by directory prefix: `src/api,lib` (comma-separated)
- `--since <t>` — Filter by time: `30d`, `2w`, `3m`, or ISO date
- `--include-skeleton` — Attach AST skeletons (imports, class/function signatures)
- `--include-summary` — Attach Haiku-generated directory summaries
- `--include-snippet` — Attach source code snippets with line numbers (best-matching entry, up to 20 lines)
- `--explain` — Show per-result score breakdown (cosine, commit boost, parent boost, BM25 keyword score, length penalty)
- `--format <f>` — Output format: `json` (default), `pretty` (human-readable), `compact` (filePath:lineStart:score per line)
- `--pretty` — Alias for `--format pretty`

### Interpreting results

Results are JSON by default. Each result has:
- `filePath` — relative path (or commit hash for commit results)
- `finalScore` — overall relevance after boosting (higher is better)
- `cosineSimilarity` — raw embedding similarity before boosts
- `type` — file extension (`.ts`, `.py`), `"dir"`, or `"commit"`
- `inProject` — `true` if from the current repo, `false` if cross-repo
- `repoId` — which repo (only present for cross-repo results)
- `lineStart`, `lineEnd` — source line range (when `--include-snippet` is used)
- `snippet` — source code excerpt (when `--include-snippet` is used)

A `finalScore` above 0.5 is usually a strong match. Between 0.3-0.5 is worth investigating. Below 0.3 is filtered by default.

## Intent Layer

Generate and monitor an AGENTS.md file that maps directory structure to purpose:

```bash
# Generate AGENTS.md from indexed directory summaries
codeindex intent --out AGENTS.md

# Detect stale summaries by comparing AGENTS.md against current DB embeddings
codeindex drift --threshold 0.3

# Drift outputs fresh/stale/missing status per directory
codeindex drift --out drift-report.json
```

## Repo management

Manage multiple indexed repositories (requires PostgreSQL for cross-repo search):

```bash
codeindex repo add /path/to/repo    # Register a repo
codeindex repo list                  # List all registered repos
codeindex repo status my-repo        # Show detailed repo stats
codeindex repo remove my-repo        # Remove repo and all indexed data
codeindex repo purge my-repo --force # Remove without confirmation prompt
```

## Cross-repo intelligence

Trace symbols and dependencies across repositories:

```bash
# Find all consumers of a symbol across repos
codeindex xref UserDTO

# JSON output for programmatic use
codeindex xref UserDTO --format json

# Dependency graph (JSON, Mermaid, or DOT output)
codeindex graph --format mermaid
codeindex graph --format dot
codeindex graph --format json
```

## MCP server

codeindex runs as a persistent MCP server for agent integration (Claude Code, Cursor, Windsurf). Eliminates CLI startup overhead.

```bash
# Start MCP server (stdio transport for Claude Code / Cursor)
codeindex serve

# SSE transport for remote/web clients
codeindex serve --transport sse --port 3100

# Print MCP config JSON for editor integration
codeindex mcp-config
codeindex mcp-config --transport sse --port 3100
```

### MCP tools available

| Tool | Description |
|------|-------------|
| `search` | Semantic search with all CLI flags |
| `batchSearch` | Multiple queries in one call (shared embedding, deduplication) |
| `searchChanged` | Files modified since a timestamp, optionally filtered by semantic query |
| `intent` | Generate AGENTS.md from directory summaries |
| `drift` | Detect stale intent nodes |
| `status` | Index stats with optional cost breakdown |
| `health` | Schema version, connection status, index freshness |
| `check` | Run health policies |
| `getImporters` | Find files that import a given file |
| `getDependencies` | Find files imported by a given file |
| `traceImportChain` | Trace transitive import paths between files |
| `getCrossRepoEdges` | Cross-repo import relationships |
| `findImplementors` | Find implementations of an interface/trait/protocol |
| `findCallers` | Find callers of a function/method |
| `reindexFiles` | Trigger reindex of specific files (rate-limited, max 50/call) |

MCP results include `indexedAt` timestamp and `stale` boolean for trust decisions. Authentication via scoped tokens (`codeindex token create`).

## Other CLI commands

```bash
codeindex reindex                    # Full reindex of current repo
codeindex update --files a.ts b.ts   # Incremental update (post-commit hook calls this)
codeindex export --out snapshot.db   # Export to portable SQLite
codeindex install-hook               # Install git post-commit hook
codeindex config                     # Show current config
codeindex config --gamma 0.15        # Tune scoring parameters
codeindex status                     # Index stats (file count, last indexed, etc.)
codeindex status --cost              # Show token usage and cost breakdown
codeindex xref <symbol>              # Cross-repo symbol resolution
codeindex graph                      # Dependency DAG visualization
codeindex check                      # Run health policies
codeindex check --json               # Machine-readable health output
codeindex manifest                   # Audit trail: indexed, skipped, flagged
codeindex doctor                     # Verify environment and config
codeindex mcp-config                 # Print MCP server config for editors
codeindex telemetry                  # Usage telemetry management
codeindex setup                      # Guided setup wizard
```

## Custom queries via code

When the CLI doesn't cover your query, write code against the codeindex database directly. The schema is straightforward and the escape hatches accept raw parameterized SQL.

### Schema

```sql
repos          (id, origin_url, root_path, name, formatter_cmd)
files          (id, repo_id, file_path, content_hash, skeleton, skeleton_entries, file_type, embedding, indexed_at)
directories    (id, repo_id, dir_path, concat_skeleton, concat_embedding, summary, summary_embedding)
commits        (id, repo_id, commit_hash, message, embedding, authored_at)
file_commits   (file_id, commit_id, recency)   -- recency 1 = most recent
cost_events    (id, repo_id, operation, model, tokens_in, tokens_out, cost_usd, created_at)
file_imports   (id, source_file_id, imported_module, resolved_file_id, language)
cross_repo_edges (id, source_repo_id, target_repo_id, source_file_id, target_file_id, import_specifier)
access_tokens  (id, name, token_hash, expires_at, revoked_at, created_at)
```

`skeleton_entries` stores JSON array of `{ name, kind, startLine, endLine }` for AST-extracted code entities.

Embeddings are 1536-dimensional vectors (`text-embedding-3-small`). PostgreSQL uses pgvector; SQLite uses sqlite-vec.

### Escape hatches

```typescript
import { pgUnsafe } from "./src/db/pg";        // pgUnsafe(sql, params?) => rows
import { sqliteUnsafe } from "./src/db/sqlite"; // sqliteUnsafe(sql, params?) => rows

// Find all files changed in the last 3 commits
const recent = await pgUnsafe(`
  SELECT DISTINCT f.file_path
  FROM file_commits fc
  JOIN files f ON f.id = fc.file_id
  WHERE fc.recency <= 3 AND f.repo_id = $1
`, [repoId]);

// Cosine similarity search with pgvector
const similar = await pgUnsafe(`
  SELECT file_path, 1 - (embedding <=> $1) AS sim
  FROM files WHERE repo_id = $2
  ORDER BY sim DESC LIMIT 10
`, [vecLiteral, repoId]);

// Find directories with summaries mentioning a topic
const dirs = await pgUnsafe(`
  SELECT dir_path, summary
  FROM directories
  WHERE repo_id = $1 AND summary ILIKE $2
`, [repoId, '%migration%']);
```

The built-in search functions (`search`, `searchFiles`, `searchDirectories`, `searchCommits` from `src/search/query.ts`) handle embedding, scoring, and cross-repo resolution automatically. Use them when possible; drop to `pgUnsafe`/`sqliteUnsafe` when you need joins, aggregations, or queries the CLI can't express.

## Scoring (for tuning)

The scoring formula uses hybrid semantic+keyword fusion with length normalization:

```
semanticScore = fileSim + alpha * commitBoost + beta * parentBoost - lengthPenalty
finalScore = (1 - hybridWeight) * semanticScore + hybridWeight * normalizedBM25
```

- BM25 keyword scoring operates on skeleton text for keyword-heavy queries
- Length normalization penalizes oversized skeletons (log-scale, weight 0.05)
- Directory results get a child-to-parent boost when multiple child files score highly
- Use `--explain` to see the full score breakdown for each result

Tune via `codeindex config`:
- `--alpha <f>` — Commit boost weight (default 0.15)
- `--beta <f>` — Parent directory boost weight (default 0.2)
- `--gamma <f>` — Child-to-parent boost weight (default 0.1)
- `--decay <f>` — Commit recency decay (default 0.2)
- `--min-score <f>` — Global filter threshold (default 0.3)
- `--parent-boost-multiplier <f>` — Parent boost multiplier (default 0.3)

## Programmatic API

For agent or library use, import from `src/api.ts`:

```typescript
import { search, searchFiles, searchDirectories, searchCommits, loadConfig, getCostSummary, extractImports, resolveImport, discoverCrossRepoEdges, pgUnsafe, getSqlite } from "./src/api";

// Semantic search
const results = await search("/path/to/repo", "authentication middleware", { topN: 5, explain: true });

// Import graph queries
const imports = await extractImports("/path/to/file.ts", "typescript");
const resolved = await resolveImport("./utils", "/path/to/file.ts", fileIndex);
```
