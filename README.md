# codeindex

A local semantic index for codebases. Augments Claude Code's built-in Glob/Grep/Read tools with embedding-based search so the agent knows *where to look* before doing text search.

## Prerequisites

- [Bun](https://bun.sh) runtime
- `OPENAI_API_KEY` environment variable (for `text-embedding-3-small` embeddings)
- `claude` CLI (optional, for directory summary generation)
- PostgreSQL with [pgvector](https://github.com/pgvector/pgvector) (optional — SQLite is the default)

## Setup

```bash
bun install

# Initialize in any git repo (auto-detects SQLite by default)
bun src/index.ts init

# Or with PostgreSQL (auto-detected if PGHOST or DATABASE_URL is set)
PGHOST=localhost bun src/index.ts init
```

Run `bun src/index.ts doctor` to verify your environment is configured correctly.

## Usage

### Index a repository

```bash
# Full reindex of the current directory
bun src/index.ts reindex

# Index a specific repo
bun src/index.ts reindex --path /path/to/repo

# Preview what would be indexed without writing
bun src/index.ts reindex --dry-run
```

### Search

```bash
# Semantic search (JSON output)
bun src/index.ts search "authentication middleware"

# Human-readable output
bun src/index.ts search "database connection pooling" --pretty

# With options
bun src/index.ts search "error handling" --min-score 0.4 --top-n 10 --include-skeleton

# With code snippets and line numbers
bun src/index.ts search "scoring formula" --include-snippet --pretty

# Cross-repo search
bun src/index.ts search "API endpoints" --scope all
```

### Intent Layer

Generate and monitor an `AGENTS.md` file that maps directory structure to purpose:

```bash
# Generate AGENTS.md from indexed directory summaries
bun src/index.ts intent --out AGENTS.md

# Detect stale summaries by comparing AGENTS.md against DB embeddings
bun src/index.ts drift --threshold 0.3
```

### Repo management

Manage multiple indexed repositories:

```bash
bun src/index.ts repo add /path/to/repo    # Register a repo
bun src/index.ts repo list                  # List all registered repos
bun src/index.ts repo status my-repo        # Show detailed stats
bun src/index.ts repo remove my-repo        # Remove repo and indexed data
bun src/index.ts repo purge my-repo --force # Remove without confirmation
```

### Incremental updates

```bash
# Install a post-commit hook for automatic indexing
bun src/index.ts install-hook

# Manual incremental update
bun src/index.ts update --files src/index.ts src/config.ts --commit abc123
```

### Other commands

```bash
bun src/index.ts status               # Show index stats
bun src/index.ts status --cost        # Show token usage and cost breakdown
bun src/index.ts config               # Show current config
bun src/index.ts config --store sqlite # Set config values
bun src/index.ts export --out snapshot.db  # Export pg to sqlite
bun src/index.ts doctor               # Check environment and configuration
```

### Eval framework

Measure search quality and compare scoring configurations:

```bash
# Run evaluation against labeled queries
bun eval/run-eval.ts --repo /path/to/repo

# Compare against ripgrep baseline
bun eval/run-eval.ts --ripgrep

# Run signal ablation study
bun eval/ablation.ts
```

## How it works

### Indexing pipeline

1. **Walk** the repo, respecting `.gitignore` and `.indexignore`
2. **Scan** file content for secrets — skip files with potential API keys, tokens, or private keys
3. **Format** each file in-memory (auto-detected formatter) and SHA-256 hash — skip if unchanged
4. **Extract** an AST skeleton via tree-sitter (TS/JS, Python, Rust, Go, Java, C/C++, C#) with line-number tracking, or first N lines for non-code files
5. **Embed** skeletons using `text-embedding-3-small` (batched, up to 2048 per call)
6. **Embed** recent commit messages and link to files with recency ranks
7. **Summarize** directories bottom-up via `claude --print --model haiku`, then embed both the concatenated skeleton and the generated summary
8. **Record** token usage and estimated costs for each embedding and summarization call

All writes are wrapped in transactions — interrupted indexing does not leave partial state.

### Search scoring

```
final_score = file_score + alpha * commit_boost + beta * parent_boost
parent_boost = parent_boost_multiplier * dir_similarity  (when above threshold)
```

- `file_score` — cosine similarity between query and file embedding
- `commit_boost` — sum of commit similarities with exponential recency decay
- `parent_boost` — parent directory score propagation when above threshold

Results include files, directories, and commits, all filtered by `minScore` (default 0.3). With `--include-snippet`, results include source code excerpts with line numbers.

## Storage

| Backend | Use case | Vector search |
|---------|----------|---------------|
| **SQLite** (default) | Single-repo, zero-config, portable | sqlite-vec `vec_distance_cosine()` |
| **PostgreSQL** | Multi-repo, shared index | pgvector `<=>` operator |

## Ignore patterns

Files are excluded from indexing via three layers (in evaluation order):

1. **Hard-coded** — `.git/` and `.codeindex.db` are always excluded and cannot be overridden
2. **Soft defaults** — `node_modules/`, `.env`, `*.pem`, lock files, build artifacts, etc.
3. **`.gitignore`** — standard git ignore rules
4. **`.indexignore`** — additional patterns, same syntax as `.gitignore`

`.indexignore` patterns override `.gitignore` and soft defaults. Use `!` to un-ignore:

```gitignore
# .indexignore — index node_modules for dependency debugging
!node_modules/
```

## Configuration

Global config at `~/.config/codeindex/config.json`, per-repo override at `.codeindex.json`.

## Project structure

```
src/
  index.ts                CLI entry point
  cli.ts                  Argument parsing
  config.ts               Config loading and formatter auto-detection
  cost.ts                 Cost tracking and summary
  intent.ts               AGENTS.md generation from directory summaries
  drift.ts                Stale Intent Node detection
  repo.ts                 Repo add/remove/list/status/purge
  db/
    pg.ts                 PostgreSQL connection (pgvector)
    sqlite.ts             SQLite connection (sqlite-vec)
    schema.ts             Table creation for both backends
    util.ts               Embedding serialization, cosine similarity
    export.ts             pg -> sqlite snapshot
  index/
    walker.ts             File tree walk (.gitignore + .indexignore)
    skeleton.ts           Tree-sitter AST skeleton extraction with line tracking
    formatter.ts          In-memory formatting and content hashing
    embedder.ts           OpenAI text-embedding-3-small with cost recording
    commits.ts            Git commit history extraction
    directories.ts        Bottom-up directory summary generation
    secrets.ts            Pre-embedding secret detection
  search/
    query.ts              Scoring engine with snippet support
    types.ts              TypeScript interfaces
  hooks/
    post-commit.ts        Git hook installer
eval/
  types.ts                Eval framework interfaces
  dataset.json            Labeled queries with expected results
  summary-assessments.json  Directory summary quality ratings
  run-eval.ts             Eval harness (precision@5, recall, MRR)
  ripgrep-baseline.ts     Ripgrep comparison baseline
  ablation.ts             Signal ablation study
```

## Development

```bash
bun run check            # lint + typecheck + format check
bun run format           # Prettier write
bun run lint:fix         # ESLint with auto-fix
```
