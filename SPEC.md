# codeindex

A local semantic index for codebases. Augments Claude Code's built-in Glob/Grep/Read tools with embedding-based search so the agent knows *where to look* before doing text search.

## Inspirations

### OpenViking — Agent-native Context Database
- **Repo**: https://github.com/volcengine/OpenViking
- **AST extraction**: https://github.com/volcengine/OpenViking/tree/main/openviking/parse/parsers/code/ast
- **Tree builder**: https://github.com/volcengine/OpenViking/blob/main/openviking/parse/tree_builder.py
- **Semantic processor (L0/L1 generation)**: https://github.com/volcengine/OpenViking/blob/main/openviking/storage/queuefs/semantic_processor.py
- **Semantic DAG (bottom-up processing)**: https://github.com/volcengine/OpenViking/blob/main/openviking/storage/queuefs/semantic_dag.py
- **Hierarchical retriever**: https://github.com/volcengine/OpenViking/blob/main/openviking/retrieve/hierarchical_retriever.py
- **Collection schemas**: https://github.com/volcengine/OpenViking/blob/main/openviking/storage/collection_schemas.py
- **Embedding utils**: https://github.com/volcengine/OpenViking/blob/main/openviking/utils/embedding_utils.py
- **What we took**: AST skeleton extraction via tree-sitter, directory summary generation (bottom-up L0/L1 pattern), score propagation from parent directories, content-hash-based change detection, dual embedding per directory (concatenation + summary).
- **What we skipped**: Hierarchical priority-queue traversal, session/memory management, custom C++ KV engine, AGFS virtual filesystem, hotness scoring, LLM-based reranking, intent analysis query expansion.

### Augment Context Services — Cloud Code Search
- **Docs**: https://docs.augmentcode.com/context-services/overview
- **SDK API Reference**: https://docs.augmentcode.com/context-services/sdk/api-reference.md
- **MCP Overview**: https://docs.augmentcode.com/context-services/mcp/overview.md
- **Context Connectors**: https://docs.augmentcode.com/context-services/context-connectors/how-it-works.md
- **What we took**: The idea of a single `codebase-retrieval` tool that returns file paths + line numbers + snippets for LLM consumption, incremental indexing via file hashes, .gitignore-respecting file walks, formatted search results designed for agent use.
- **What we skipped**: Cloud-hosted index, proprietary embedding model, per-query credit costs, opaque chunking strategy.

### sigma-ralph-grindset — Claude CLI as LLM Backend
- **Repo**: https://github.com/smart-knowledge-systems/sigma-ralph-grindset
- **CLI backend**: https://github.com/smart-knowledge-systems/sigma-ralph-grindset/blob/main/src/audit/cli-backend.ts
- **JSON schema enforcement**: https://github.com/smart-knowledge-systems/sigma-ralph-grindset/blob/main/src/audit/schema.ts
- **What we took**: Pattern of spawning `claude --print --model haiku` with `--json-schema` for structured output, using the CLI as a cheap LLM backend without adding an SDK dependency. Dual-backend approach (CLI for dev, API for production).

### db-harness — TypeScript Database Skill Pattern
- **Repo**: `/Users/russfugal/ObsidianVault/tPoSO/db-harness`
- **What we took**: Modular skill structure with typed query functions exported as a single `db` object, dual-database abstraction (PostgreSQL + SQLite), Bun-native database access, `types.ts` for all interfaces.

---

## Architecture

```
Index time (post-commit hook or full walk):
  walk repo (respect .gitignore + .indexignore)
  for each changed file:
    pipe through project formatter (in memory) -> sha256 hash
    skip if hash unchanged
    extract AST skeleton (tree-sitter) or first N lines for non-code
    embed skeleton (text-embedding-3-small)
    store file record + embedding
  for each commit in changed files:
    embed commit message (if not already embedded)
    link file <-> commit with recency rank
  for each affected directory (bottom-up):
    concat immediate child skeletons (non-recursive)
    embed concat_skeleton
    generate summary via claude --print --model haiku:
      input: concat_skeleton + extracted docs (JSDoc, docstrings)
             + child directory summaries (recursive, but not grandchild skeletons)
    embed summary
    store directory record with both embeddings

Query time:
  embed query (text-embedding-3-small)
  cosine similarity against files, directories, commits
  apply scoring formula (commit boost + parent boost)
  filter by minScore threshold
  return ranked results with file paths, scores, types
```

---

## Storage

### PostgreSQL (default)
- One database on localhost for all indexed repos.
- Uses pgvector extension for vector similarity search.
- Default query scoped to current repo (by git remote origin); `--all` or `--repos` flags for cross-repo search.

### SQLite (portable option)
- Uses sqlite-vec extension for vector similarity search.
- `.codeindex.db` file in repo root (or custom path).
- Can be committed to the repo for sharing.

### Export
- `codeindex export` snapshots the current repo's data from PostgreSQL into a SQLite file.
- Useful for CI artifacts, sharing with teammates, or offline use.

---

## Schema

```sql
-- Identical structure for both PostgreSQL (pgvector) and SQLite (sqlite-vec).
-- Types below are PostgreSQL; SQLite equivalents noted where different.

CREATE TABLE repos (
  id            serial PRIMARY KEY,            -- SQLite: integer primary key
  origin_url    text,
  root_path     text UNIQUE NOT NULL,
  name          text NOT NULL,
  formatter_cmd text                           -- e.g. "prettier --write"
);

CREATE TABLE files (
  id            serial PRIMARY KEY,
  repo_id       int NOT NULL REFERENCES repos(id),
  file_path     text NOT NULL,                 -- relative to repo root
  content_hash  text NOT NULL,                 -- sha256 of formatted content
  skeleton      text,                          -- AST skeleton text
  file_type     text NOT NULL,                 -- ".ts", ".js", ".md", etc.
  embedding     vector(1536),                  -- SQLite: stored in vec0 virtual table
  indexed_at    timestamptz DEFAULT now(),      -- SQLite: text ISO8601
  UNIQUE(repo_id, file_path)
);

CREATE TABLE directories (
  id                  serial PRIMARY KEY,
  repo_id             int NOT NULL REFERENCES repos(id),
  dir_path            text NOT NULL,           -- relative to repo root
  concat_skeleton     text,                    -- non-recursive child skeleton concatenation
  concat_embedding    vector(1536),
  summary             text,                    -- claude haiku summary
  summary_embedding   vector(1536),
  UNIQUE(repo_id, dir_path)
);

CREATE TABLE commits (
  id            serial PRIMARY KEY,
  repo_id       int NOT NULL REFERENCES repos(id),
  commit_hash   text NOT NULL,
  message       text NOT NULL,
  embedding     vector(1536),
  authored_at   timestamptz,
  UNIQUE(repo_id, commit_hash)
);

CREATE TABLE file_commits (
  file_id       int NOT NULL REFERENCES files(id),
  commit_id     int NOT NULL REFERENCES commits(id),
  recency       int NOT NULL,                  -- 1 = most recent commit for this file
  PRIMARY KEY (file_id, commit_id)
);
```

---

## Scoring Algorithm

```
file_score     = cosine(query_embedding, file.embedding)

commit_boost   = SUM over file's commits:
                   cosine(query_embedding, commit.embedding) * (1 - decay)^(recency - 1)
                 where:
                   decay    = 0.2 (configurable)
                   depth    = 5   (configurable, max commits per file)
                 yields multipliers: 1.0, 0.8, 0.64, 0.512, 0.41

dir_score      = MAX(
                   cosine(query_embedding, dir.concat_embedding),
                   cosine(query_embedding, dir.summary_embedding)
                 )

parent_boost   = if parent directory's dir_score > minScore:
                   0.3 * dir_score
                 else:
                   0

final_score    = file_score + alpha * commit_boost + beta * parent_boost
                 where:
                   alpha = 0.15 (configurable)
                   beta  = 0.2  (configurable)
```

Commits are also returned as standalone results with `type: "commit"` when their embedding matches the query above `minScore`.

Directories are also returned as standalone results with `type: "dir"` using `dir_score` as their `finalScore`.

---

## Result Shape

```typescript
interface SearchResult {
  filePath: string           // relative to repo root (absolute if cross-repo)
  cosineSimilarity: number   // raw vector similarity (file_score or dir_score or commit score)
  finalScore: number         // after commit_boost + parent_boost
  type: string               // ".ts" | ".js" | ".md" | "dir" | "commit" | etc.
  inProject: boolean         // true if same repo as cwd
  repoId?: string            // repo name/origin when inProject is false
  commitIds?: string[]       // relevant commit hashes (for file results)
  skeleton?: string          // AST skeleton preview (included when requested)
}

interface SearchOptions {
  minScore?: number          // default 0.3, return all results >= this
  topN?: number              // optional cap on result count, default unlimited
  scope?: "project" | "all" | string[]   // repo names, default "project"
  includeSkeleton?: boolean  // include skeleton text in results, default false
}
```

---

## Indexing

### Post-commit Hook

Installed via `codeindex install-hook`. Creates `.git/hooks/post-commit`:

```bash
#!/bin/sh
files=$(git diff-tree --no-commit-id --name-only -r HEAD)
commit=$(git rev-parse HEAD)
codeindex update --files $files --commit $commit
```

The `update` command:
1. For each file: format (in memory) -> hash -> skip if unchanged -> extract skeleton -> embed -> upsert.
2. For the commit: embed message -> upsert -> link to files with recency ranks.
3. For each affected directory (bottom-up from changed files to root):
   - Re-concat immediate child skeletons.
   - Re-generate summary via `claude --print --model haiku`.
   - Re-embed both.

### Full Reindex

```bash
codeindex reindex [--store pg|sqlite] [--path ./]
```

Walks the entire file tree, respecting:
- `.gitignore` (standard git ignore rules)
- `.indexignore` (additional patterns, same syntax as .gitignore)

Processes all files and directories bottom-up. Uses content hashes to skip files that haven't changed since last index.

### Formatter Detection

Auto-detected from project config files, checked in priority order:

| Config file                          | Formatter command    |
|--------------------------------------|----------------------|
| `biome.json` / `biome.jsonc`        | `biome format`       |
| `.prettierrc*` / `prettier.config.*` | `prettier`           |
| `rustfmt.toml` / `.rustfmt.toml`    | `rustfmt`            |
| `pyproject.toml` `[tool.black]`     | `black`              |
| `pyproject.toml` `[tool.ruff]`      | `ruff format`        |
| `.clang-format`                      | `clang-format`       |
| Go files present                     | `gofmt`              |

Override: `codeindex config --formatter "prettier --write"`

The formatter is applied **in memory only** — file content is piped through the formatter, the output is hashed, but the original file on disk is not modified. This ensures formatting-only commits do not trigger re-embedding.

---

## Directory Summary Generation

Uses the sigma-ralph-grindset pattern of shelling out to `claude --print`:

```bash
claude --print \
  --model haiku \
  --output-format json \
  --json-schema '{
    "name": "dir_summary",
    "schema": {
      "type": "object",
      "properties": {
        "summary": {
          "type": "string",
          "description": "1-3 sentence summary of this directory purpose, key abstractions, and what a developer would find here."
        }
      },
      "required": ["summary"]
    }
  }' \
  "Summarize this directory.\n\nFiles in this directory:\n${concat_skeleton}\n\nDocstrings and JSDoc found:\n${extracted_docs}\n\nSubdirectory summaries:\n${child_dir_summaries}"
```

Processing order (bottom-up):
1. Leaf directories first (no child summaries available, only file skeletons + docs).
2. Parent directories next (include child directory summaries, but NOT grandchild file skeletons).
3. Continue up to repo root.

Each directory stores two independent embeddings:
- `concat_embedding`: embedding of the raw concatenated child skeletons (non-recursive).
- `summary_embedding`: embedding of the haiku-generated summary (which incorporates recursive child summaries).

---

## AST Skeleton Extraction

Uses tree-sitter to extract structural information per language. Output format:

```
# auth.service.ts [TypeScript]
imports: express, jsonwebtoken, bcrypt

class AuthService
  + login(email, password) -> Promise<Token>
    """Authenticate user and return JWT."""
  + validateToken(token) -> Promise<User>
  + refreshToken(token) -> Promise<Token>

function hashPassword(plain) -> string
function createMiddleware(options) -> RequestHandler
```

### Extracted per language:

| Language       | Extensions              | Extracts                                                    |
|----------------|-------------------------|-------------------------------------------------------------|
| TypeScript/JS  | .ts .tsx .js .jsx       | imports, classes, methods, functions, JSDoc comments         |
| Python         | .py                     | imports, classes, methods, functions, module/class docstrings|
| Rust           | .rs                     | use declarations, structs, traits, enums, impl blocks, fns  |
| Go             | .go                     | imports, structs, interfaces, functions, methods             |
| Java           | .java                   | imports, classes, interfaces, enums, methods, Javadoc        |
| C/C++          | .c .cpp .h .hpp         | includes, classes, structs, namespaces, functions, Doxygen   |
| C#             | .cs                     | usings, classes, interfaces, methods                         |

Non-code files (.md, .json, .yaml, .toml, etc.) use first N lines (configurable, default 50) as the skeleton.

---

## CLI Commands

```
codeindex reindex              Full reindex of current repo
codeindex update               Incremental update (called by hook)
  --files <paths>              Files to re-index
  --commit <hash>              Commit to embed and link
codeindex search <query>       Semantic search
  --min-score <float>          Minimum finalScore (default 0.3)
  --top-n <int>                Max results (default unlimited)
  --scope <project|all|names>  Repo scope (default project)
  --include-skeleton           Include skeleton text in output
  --json                       Output as JSON (default)
  --pretty                     Human-readable output
codeindex export               Export current repo from pg to sqlite
  --out <path>                 Output path (default .codeindex.db)
codeindex install-hook         Install post-commit git hook
codeindex config               Show/set configuration
  --formatter <cmd>            Override formatter command
  --store <pg|sqlite>          Storage backend
  --decay <float>              Commit score decay (default 0.2)
  --commit-depth <int>         Max commits per file (default 5)
  --alpha <float>              Commit boost weight (default 0.15)
  --beta <float>               Parent boost weight (default 0.2)
  --min-score <float>          Default minimum score (default 0.3)
codeindex status               Show index stats (file count, last indexed, etc.)
```

---

## Project Structure

```
codeindex/
  src/
    index.ts                   CLI entry point (command dispatch)
    config.ts                  Auto-detect formatter, load/save settings
    db/
      pg.ts                    pgvector connection (Bun native SQL)
      sqlite.ts                sqlite-vec connection (Bun native SQLite)
      schema.ts                CREATE TABLE, migrations
      export.ts                pg -> sqlite snapshot
    index/
      walker.ts                File tree walk (.gitignore + .indexignore)
      skeleton.ts              Tree-sitter AST extraction per language
      formatter.ts             Pipe through formatter, hash output
      embedder.ts              OpenAI text-embedding-3-small
      commits.ts               git log per file, embed messages, link
      directories.ts           Concat skeletons, claude haiku summary, embed
    search/
      query.ts                 Embed query, score, rank, filter by minScore
      types.ts                 SearchResult, SearchOptions interfaces
    hooks/
      post-commit.ts           Generate and install git hook script
  package.json
  tsconfig.json
  .indexignore.example
  SPEC.md                      This file
```

---

## Dependencies

| Package                  | Purpose                              |
|--------------------------|--------------------------------------|
| `tree-sitter`            | AST parsing (via WASM bindings)      |
| `tree-sitter-typescript` | TS/JS grammar                        |
| `tree-sitter-python`     | Python grammar                       |
| `tree-sitter-rust`       | Rust grammar                         |
| `tree-sitter-go`         | Go grammar                           |
| `tree-sitter-java`       | Java grammar                         |
| `tree-sitter-c`          | C grammar                            |
| `tree-sitter-cpp`        | C++ grammar                          |
| `tree-sitter-c-sharp`    | C# grammar                           |
| `openai`                 | Embedding API (text-embedding-3-small)|
| `ignore`                 | .gitignore/.indexignore parsing       |
| `sqlite-vec`             | SQLite vector extension (optional)    |

Runtime dependencies (not npm packages):
- `claude` CLI (for directory summary generation)
- `git` (for hooks, commit history, file change detection)
- PostgreSQL with pgvector (default storage)
- Project formatter (prettier, biome, etc. — auto-detected)

---

## Configuration File

Stored at `~/.config/codeindex/config.json` (global) and `.codeindex.json` (per-repo override):

```json
{
  "store": "pg",
  "pg": {
    "host": "localhost",
    "port": 5432,
    "database": "codeindex",
    "user": "postgres"
  },
  "sqlite": {
    "path": ".codeindex.db"
  },
  "embedding": {
    "model": "text-embedding-3-small",
    "dimensions": 1536
  },
  "scoring": {
    "commitDecay": 0.2,
    "commitDepth": 5,
    "alpha": 0.15,
    "beta": 0.2,
    "minScore": 0.3
  },
  "formatter": null,
  "skeletonFallbackLines": 50
}
```
