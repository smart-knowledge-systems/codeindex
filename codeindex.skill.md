# codeindex — Semantic Code Search

codeindex is a **discovery layer**: use it to find *where* relevant code lives, then use Glob/Grep/Read to get the actual content. Results are pointers (paths, scores, types), not payloads.

## Quick start

```bash
codeindex search "authentication middleware" --pretty
codeindex search "database migration" --include-skeleton --include-summary --pretty
codeindex search "error handling" --scope all          # cross-repo search
```

## CLI commands

| Command | Purpose |
|---------|---------|
| `codeindex reindex` | Full reindex of current repo |
| `codeindex update --files <paths> --commit <hash>` | Incremental update (called by post-commit hook) |
| `codeindex search <query>` | Semantic search |
| `codeindex export [--out path]` | Export pg to portable sqlite |
| `codeindex install-hook` | Install post-commit git hook |
| `codeindex config [--key value]` | Show/set configuration |
| `codeindex status` | Show index stats |

### Search flags

- `--min-score <f>` — Minimum score threshold (default 0.3)
- `--top-n <n>` — Max results to return
- `--scope <s>` — `project` (default), `all` (cross-repo), or `name1,name2`
- `--include-skeleton` — Include AST skeletons in results
- `--include-summary` — Include directory summaries in results
- `--pretty` — Human-readable ranked list

## Database schema

PostgreSQL (pgvector) is the default backend. SQLite (sqlite-vec) is used for portable exports.

```
repos          (id, origin_url, root_path, name, formatter_cmd)
files          (id, repo_id, file_path, content_hash, skeleton, file_type, embedding, indexed_at)
directories    (id, repo_id, dir_path, concat_skeleton, concat_embedding, summary, summary_embedding)
commits        (id, repo_id, commit_hash, message, embedding, authored_at)
file_commits   (file_id, commit_id, recency)   -- recency 1 = most recent
```

## Writing custom SQL

When the built-in search functions don't fit, use the raw SQL escape hatches:

```typescript
import { pgUnsafe } from "./src/db/pg";       // PostgreSQL
import { sqliteUnsafe } from "./src/db/sqlite"; // SQLite

// Example: find files with no embedding yet
const unembedded = await pgUnsafe(
  "SELECT file_path FROM files WHERE repo_id = $1 AND embedding IS NULL",
  [repoId]
);

// Example: cosine similarity with pgvector
const similar = await pgUnsafe(
  "SELECT file_path, 1 - (embedding <=> $1) AS sim FROM files WHERE repo_id = $2 ORDER BY sim DESC LIMIT 10",
  [vecLiteral, repoId]
);
```

## Scoring formula

```
finalScore = fileSim + alpha * commitBoost + beta * parentBoost

commitBoost  = SUM( commitSim * (1 - decay)^(recency - 1) )   up to commitDepth
parentBoost  = dirSim > minScore ? 0.3 * dirSim : 0
childBoost   = if >= 2 children above minScore: gamma * AVG(child scores)
```

Defaults: `alpha=0.15, beta=0.2, gamma=0.1, decay=0.2, commitDepth=5, minScore=0.3`

## Usage pattern

1. **Search** with codeindex to find relevant paths and scores
2. **Read/Grep/Glob** to get the actual file contents you need
3. Do not treat search results as complete context — they are starting points for exploration
