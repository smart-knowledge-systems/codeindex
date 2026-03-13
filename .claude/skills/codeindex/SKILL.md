---
name: codeindex
description: Semantic code search across indexed repositories. Use this skill when you need to find where relevant code lives in a large or unfamiliar codebase — especially when you don't know the right file names, class names, or grep patterns. codeindex searches by meaning, not keywords, so it excels at queries like "where is rate limiting implemented" or "find the database connection pooling logic." Use it before resorting to broad Glob/Grep sweeps. Also use this skill when searching across multiple repositories at once with --scope all.
---

# codeindex

codeindex is a semantic search index for codebases. It embeds file skeletons, directory summaries, and commit messages, then ranks results using cosine similarity with commit-recency and directory-hierarchy boosts.

**It is a discovery layer, not a context dump.** Search results are pointers — file paths, scores, and types. Use them to decide where to look, then pull actual content with the Read tool (for file contents), Grep (for keyword search within files), and Glob (for file pattern matching). Always use the dedicated Claude Code tools (Read, Grep, Glob) — never shell equivalents like `cat`, `head`, `tail`, `grep`, or `find`.

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

# Step 4: Read the actual files using the Read tool (never cat/head/tail)
# Example: Read("src/middleware/rateLimiter.ts")

# Step 5: Follow up with Grep tool (never shell grep) for keyword search
# Example: Grep("rateLimiter", path="src/middleware/")
```

### Search flags

- `--min-score <f>` — Filter threshold (default 0.3). Raise to reduce noise, lower to cast a wider net
- `--top-n <n>` — Cap the number of results
- `--scope <s>` — `project` (default), `all` (every indexed repo), or `repo1,repo2`
- `--include-skeleton` — Attach AST skeletons (imports, class/function signatures)
- `--include-summary` — Attach Haiku-generated directory summaries
- `--pretty` — Human-readable ranked output instead of JSON

### Interpreting results

Results are JSON by default. Each result has:
- `filePath` — relative path (or commit hash for commit results)
- `finalScore` — overall relevance after boosting (higher is better)
- `cosineSimilarity` — raw embedding similarity before boosts
- `type` — file extension (`.ts`, `.py`), `"dir"`, or `"commit"`
- `inProject` — `true` if from the current repo, `false` if cross-repo
- `repoId` — which repo (only present for cross-repo results)

A `finalScore` above 0.5 is usually a strong match. Between 0.3-0.5 is worth investigating. Below 0.3 is filtered by default.

## Other CLI commands

```bash
codeindex reindex                    # Full reindex of current repo
codeindex update --files a.ts b.ts   # Incremental update (post-commit hook calls this)
codeindex export --out snapshot.db   # Export to portable SQLite
codeindex install-hook               # Install git post-commit hook
codeindex config                     # Show current config
codeindex config --gamma 0.15        # Tune scoring parameters
codeindex status                     # Index stats (file count, last indexed, etc.)
```

## Custom queries via code

When the CLI doesn't cover your query, write code against the codeindex database directly. The schema is straightforward and the escape hatches accept raw parameterized SQL.

### Schema

```sql
repos          (id, origin_url, root_path, name, formatter_cmd)
files          (id, repo_id, file_path, content_hash, skeleton, file_type, embedding, indexed_at)
directories    (id, repo_id, dir_path, concat_skeleton, concat_embedding, summary, summary_embedding)
commits        (id, repo_id, commit_hash, message, embedding, authored_at)
file_commits   (file_id, commit_id, recency)   -- recency 1 = most recent
```

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

The scoring formula combines embedding similarity with commit-recency and directory-hierarchy signals:

```
finalScore = fileSim + alpha * commitBoost + beta * parentBoost
```

Directory results also get a child-to-parent boost when multiple child files score highly.

Tune via `codeindex config`:
- `--alpha <f>` — Commit boost weight (default 0.15)
- `--beta <f>` — Parent directory boost weight (default 0.2)
- `--gamma <f>` — Child-to-parent boost weight (default 0.1)
- `--decay <f>` — Commit recency decay (default 0.2)
- `--min-score <f>` — Global filter threshold (default 0.3)
