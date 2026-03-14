# codeindex

A semantic search engine for codebases. Uses embeddings, AST extraction, import graph analysis, and commit history to help developers and AI agents find relevant code faster than grep/ripgrep. Supports 18 languages, cross-repo intelligence, re-ranking, and MCP server mode for agent integration.

## Prerequisites

- [Bun](https://bun.sh) runtime
- One of:
  - `OPENAI_API_KEY` for OpenAI `text-embedding-3-small` embeddings, or
  - [Ollama](https://ollama.com) with `nomic-embed-text` for local embeddings (no API key needed)
- `claude` CLI or `ANTHROPIC_API_KEY` (for directory summary generation)
- PostgreSQL with [pgvector](https://github.com/pgvector/pgvector) (optional — SQLite is the default)

## Setup

```bash
bun install

# Initialize in any git repo (auto-detects SQLite by default)
bun src/index.ts init

# Or with PostgreSQL (auto-detected if PGHOST or DATABASE_URL is set)
PGHOST=localhost bun src/index.ts init

# Or use the guided setup wizard (multi-repo scanning, store selection)
bun src/index.ts setup
```

Run `bun src/index.ts doctor` to verify your environment is configured correctly.

## Usage

### Index a repository

```bash
# Full reindex of the current directory
bun src/index.ts reindex

# Preview what would be indexed and projected cost
bun src/index.ts reindex --dry-run

# Set a cost cap (USD)
bun src/index.ts reindex --budget 2.00

# Parallel reindex of all registered repos
bun src/index.ts reindex --scope all --workers 4
```

### Search

```bash
# Semantic search (JSON output)
bun src/index.ts search "authentication middleware"

# Human-readable output
bun src/index.ts search "database connection pooling" --pretty

# With filtering and options
bun src/index.ts search "error handling" --lang ts --dir src/api --since 30d --top-n 10

# With code snippets and score breakdown
bun src/index.ts search "scoring formula" --include-snippet --explain --pretty

# Cross-repo search
bun src/index.ts search "API endpoints" --scope all
```

### MCP server (agent integration)

Start a persistent MCP server for AI agent integration with Claude Code, Cursor, or Windsurf:

```bash
# stdio transport (default — for Claude Code, Cursor)
bun src/index.ts serve

# SSE transport (for remote/web clients)
bun src/index.ts serve --transport sse --port 3100
```

Exposes 14 MCP tools including `search`, `batchSearch`, `searchChanged`, `intent`, `drift`, `status`, `health`, `check`, `getImporters`, `getDependencies`, `traceImportChain`, `getCrossRepoEdges`, `findImplementors`, `findCallers`, and `reindexFiles`. Authenticated via scoped tokens. Eliminates CLI startup overhead for agent workflows.

### Intent layer

Generate and monitor an `AGENTS.md` file that maps directory structure to purpose:

```bash
# Generate AGENTS.md from indexed directory summaries
bun src/index.ts intent --out AGENTS.md

# Detect stale summaries
bun src/index.ts drift --threshold 0.3
```

### Repo management

Manage multiple indexed repositories (PostgreSQL backend):

```bash
bun src/index.ts repo add /path/to/repo
bun src/index.ts repo list
bun src/index.ts repo status my-repo
bun src/index.ts repo remove my-repo
bun src/index.ts repo purge my-repo --force
```

### Cross-repo intelligence

Trace symbols and dependencies across repositories:

```bash
# Find all consumers of a symbol across repos
bun src/index.ts xref UserDTO

# Dependency graph (JSON, Mermaid, or DOT)
bun src/index.ts graph --format mermaid
bun src/index.ts graph --format dot | dot -Tsvg > deps.svg
```

### Health checks

Policy-based index health validation:

```bash
bun src/index.ts check         # Run all health policies
bun src/index.ts check --json  # Machine-readable output
```

### Export and CI/CD

```bash
# Export PG index to portable SQLite (embeddings redacted by default)
bun src/index.ts export --out snapshot.db

# Include embeddings in export
bun src/index.ts export --out snapshot.db --include-embeddings

# Use exported index in read-only mode
bun src/index.ts search "auth" --path ./snapshot.db --read-only
```

### Access control (shared PG)

Scoped tokens for multi-tenant PostgreSQL deployments:

```bash
bun src/index.ts token create --name ci-reader --repos 1,2,3
bun src/index.ts token list
bun src/index.ts token revoke --id 7
```

### Other commands

```bash
bun src/index.ts status               # Index stats
bun src/index.ts status --cost        # Token usage and cost breakdown
bun src/index.ts config               # Show current config
bun src/index.ts manifest             # Audit trail: indexed, skipped, flagged files
bun src/index.ts install-hook         # Install post-commit hook for auto-indexing
bun src/index.ts doctor               # Verify environment and configuration
bun src/index.ts xref <symbol>           # Cross-repo symbol resolution
bun src/index.ts graph                   # Dependency DAG visualization
bun src/index.ts telemetry               # Usage telemetry management
bun src/index.ts mcp-config              # Print MCP server config for editors
```

## How it works

### Indexing pipeline

1. **Walk** the repo, respecting `.gitignore` and `.indexignore`
2. **Scan** file content for secrets — skip files with potential API keys, tokens, or private keys
3. **Format** each file in-memory (auto-detected formatter) and SHA-256 hash — skip if unchanged
4. **Extract** an AST skeleton via tree-sitter for supported languages, or first N lines for non-code files
5. **Extract imports** from tree-sitter skeletons into the `file_imports` table for dependency graph queries
6. **Embed** skeletons using the configured embedding provider (batched)
7. **Embed** recent commit messages and link to files with recency ranks
8. **Summarize** directories bottom-up (cached by content hash — ~90% cost reduction on incremental reindex)
9. **Discover** cross-repo relationships from import edges across registered repos
10. **Record** token usage and estimated costs

All writes are wrapped in transactions. Schema migrations run automatically on `init`.

### Supported languages (18)

TypeScript/JavaScript, Python, Rust, Go, Java, C, C++, C#, Kotlin, Swift, Ruby, PHP, Lua, Scala, Zig, Elixir — with AST-based skeleton extraction, line-number tracking, and import graph indexing.

### Search scoring

```
final_score = semantic + gamma * keyword + alpha * commit_boost + beta * parent_boost
```

- **semantic** — cosine similarity between query and file embedding
- **keyword** — BM25 keyword matching (hybrid search)
- **commit_boost** — sum of commit similarities with exponential recency decay
- **parent_boost** — parent directory score propagation

Results include files, directories, and commits. Per-language scoring profiles adjust weights automatically. Use `--explain` to see the full score breakdown per result.

## Storage

| Backend | Use case | Vector search |
|---------|----------|---------------|
| **SQLite** (default) | Single-repo, zero-config, portable, CI/CD | sqlite-vec `vec_distance_cosine()` |
| **PostgreSQL** | Multi-repo, shared index, cross-repo intelligence | pgvector `<=>` operator with HNSW indexes |

## Embedding providers

| Provider | Model | Cost | Setup |
|----------|-------|------|-------|
| **OpenAI** (default) | `text-embedding-3-small` | ~$0.02/1K files | `OPENAI_API_KEY` env var |
| **Ollama** (local) | `nomic-embed-text` | Free | `ollama pull nomic-embed-text` |
| **Anthropic** | `voyage-3-lite` | ~$0.02/1K files | `ANTHROPIC_API_KEY` env var |

## Ignore patterns

Files are excluded from indexing via three layers:

1. **Hard-coded** — `.git/` and `.codeindex.db` are always excluded
2. **Soft defaults** — `node_modules/`, `.env`, `*.pem`, lock files, build artifacts
3. **`.gitignore`** — standard git ignore rules
4. **`.indexignore`** — additional patterns, same syntax as `.gitignore`

`.indexignore` supports `!` to override `.gitignore` and soft defaults:

```gitignore
# .indexignore — index node_modules for dependency debugging
!node_modules/
```

## Configuration

Global config at `~/.config/codeindex/config.json`, per-repo override at `.codeindex.json`.

## Eval framework

Measure search quality and compare scoring configurations:

```bash
bun eval/run-eval.ts --repo /path/to/repo    # Run eval against labeled queries
bun eval/run-eval.ts --ripgrep               # Compare against ripgrep baseline
bun eval/ablation.ts                          # Signal ablation study
bun eval/compare-models.ts                    # Compare embedding models
```

## Development

```bash
bun run check            # lint + typecheck
bun run format           # Prettier write
bun run lint:fix         # ESLint with auto-fix
bun test                 # Run tests
```

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the historic product backlog (M0-M6, substantially complete). See [WHATS_NEXT.md](WHATS_NEXT.md) for remaining work identified by the dialogue team audit.
