# CI/CD Integration Guide

## Exporting a Redacted SQLite Snapshot

Use `codeindex export` to produce a portable SQLite file suitable for CI
environments. By default, embedding vectors are stripped to keep the file small
and avoid leaking model-specific data.

```bash
# Default: embeddings redacted, commits included
codeindex export --out snapshot.db

# Also strip commit history
codeindex export --out snapshot.db --redact-commits

# Keep embeddings (for semantic search in CI)
codeindex export --out snapshot.db --include-embeddings

# Exclude specific file patterns
codeindex export --out snapshot.db --exclude "test/**,docs/**"
```

The export also respects `.indexignore` patterns, so any files excluded from
indexing will also be excluded from the export.

## Read-Only Mode

In CI pipelines you typically want to query an existing index without
accidentally modifying it. Pass `--read-only` to block write operations:

```bash
# Search is allowed
codeindex search "authentication handler" --read-only

# These will fail with a clear error
codeindex reindex --read-only   # Error: blocked in read-only mode
codeindex init --read-only      # Error: blocked in read-only mode
```

You can also set `readOnly` permanently in `.codeindex.json`:

```json
{
  "store": "sqlite",
  "readOnly": true
}
```

Write operations blocked in read-only mode: `init`, `reindex`, `update`,
`install-hook`.

## GitHub Actions Example

```yaml
name: Code Search Check
on: [pull_request]

jobs:
  search-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Download index snapshot
        uses: actions/download-artifact@v4
        with:
          name: codeindex-snapshot
          path: .

      - name: Search for TODO items
        run: |
          bunx codeindex search "TODO fixme hack" \
            --read-only \
            --format compact \
            --min-score 0.4

      - name: Check drift
        run: |
          bunx codeindex drift \
            --read-only \
            --threshold 0.3
```

### Producing the Snapshot

Run the export step in a scheduled workflow or after merges to `main`:

```yaml
name: Build Index Snapshot
on:
  push:
    branches: [main]

jobs:
  export:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Reindex
        run: bunx codeindex reindex

      - name: Export snapshot
        run: bunx codeindex export --out snapshot.db --redact-commits

      - uses: actions/upload-artifact@v4
        with:
          name: codeindex-snapshot
          path: snapshot.db
          retention-days: 7
```
