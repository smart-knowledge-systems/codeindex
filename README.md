# codeindex

A local semantic index for codebases. Augments Claude Code's built-in Glob/Grep/Read tools with embedding-based search so the agent knows *where to look* before doing text search.

## Prerequisites

- [Bun](https://bun.sh) runtime
- PostgreSQL with [pgvector](https://github.com/pgvector/pgvector) extension (default storage)
- `OPENAI_API_KEY` environment variable (for `text-embedding-3-small` embeddings)
- `claude` CLI (optional, for directory summary generation)

## Setup

```bash
bun install

# Create the database and enable pgvector
createdb codeindex
psql -d codeindex -c "CREATE EXTENSION IF NOT EXISTS vector"
```

## Usage

### Index a repository

```bash
# Full reindex of the current directory
bun src/index.ts reindex

# Index a specific repo
bun src/index.ts reindex --path /path/to/repo
```

### Search

```bash
# Semantic search (JSON output)
bun src/index.ts search "authentication middleware"

# Human-readable output
bun src/index.ts search "database connection pooling" --pretty

# With options
bun src/index.ts search "error handling" --min-score 0.4 --top-n 10 --include-skeleton

# Cross-repo search
bun src/index.ts search "API endpoints" --scope all
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
bun src/index.ts config               # Show current config
bun src/index.ts config --store sqlite # Set config values
bun src/index.ts export --out snapshot.db  # Export pg to sqlite
```

## How it works

### Indexing pipeline

1. **Walk** the repo, respecting `.gitignore` and `.indexignore`
2. **Format** each file in-memory (auto-detected formatter) and SHA-256 hash — skip if unchanged
3. **Extract** an AST skeleton via tree-sitter (TS/JS, Python, Rust, Go, Java, C/C++, C#) or first N lines for non-code files
4. **Embed** skeletons using `text-embedding-3-small` (batched, up to 2048 per call)
5. **Embed** recent commit messages and link to files with recency ranks
6. **Summarize** directories bottom-up via `claude --print --model haiku`, then embed both the concatenated skeleton and the generated summary

### Search scoring

```
final_score = file_score + alpha * commit_boost + beta * parent_boost
```

- `file_score` — cosine similarity between query and file embedding
- `commit_boost` — sum of commit similarities with exponential recency decay
- `parent_boost` — parent directory score propagation when above threshold

Results include files, directories, and commits, all filtered by `minScore` (default 0.3).

## Storage

| Backend | Use case | Vector search |
|---------|----------|---------------|
| **PostgreSQL** (default) | Multi-repo, shared index | pgvector `<=>` operator |
| **SQLite** (portable) | Single-repo, offline, CI | sqlite-vec `vec_distance_cosine()` |

## Configuration

Global config at `~/.config/codeindex/config.json`, per-repo override at `.codeindex.json`.

## Project structure

```
src/
  index.ts                CLI entry point
  config.ts               Config loading and formatter auto-detection
  db/
    pg.ts                 PostgreSQL connection (pgvector)
    sqlite.ts             SQLite connection (sqlite-vec)
    schema.ts             Table creation for both backends
    export.ts             pg → sqlite snapshot
  index/
    walker.ts             File tree walk (.gitignore + .indexignore)
    skeleton.ts           Tree-sitter AST skeleton extraction
    formatter.ts          In-memory formatting and content hashing
    embedder.ts           OpenAI text-embedding-3-small
    commits.ts            Git commit history extraction
    directories.ts        Bottom-up directory summary generation
  search/
    query.ts              Scoring engine (pgvector + sqlite-vec)
    types.ts              TypeScript interfaces
  hooks/
    post-commit.ts        Git hook installer
```

## Development

```bash
bun run check            # lint + typecheck + format check
bun run format           # Prettier write
bun run lint:fix         # ESLint with auto-fix
```
