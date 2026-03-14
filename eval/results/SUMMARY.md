# Eval Results: baseline

Run at: 2026-03-14T03:50:04.594Z

## Aggregate Metrics

| Metric | Value |
|--------|-------|
| Avg P@5 | 0.154 |
| Avg HitRate@5 | 0.718 |
| Avg Recall | 0.749 |
| Avg MRR | 0.476 |
| Avg nDCG@10 | 0.531 |
| Avg Unique Files in Top 5 | 4.03 |
| Avg Unique Dirs in Top 5 | 3.57 |

> **P@5** = hits in top 5 / 5 (standard). **HitRate@5** = hits in top 5 / min(5, expected) — more useful when most queries have 1 expected file.

## Per-Query Results

| Query | P@5 | HR@5 | Recall | MRR | nDCG | Files@5 | Dirs@5 |
|-------|-----|------|--------|-----|------|---------|--------|
| embedding-vector-search | 0.20 | 0.50 | 1.00 | 1.00 | 0.80 | 5 | 4 |
| tree-sitter-skeleton | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 4 |
| git-commit-recency | 0.20 | 1.00 | 1.00 | 0.25 | 0.43 | 5 | 5 |
| database-schema | 0.20 | 1.00 | 1.00 | 0.33 | 0.50 | 5 | 5 |
| file-walking-gitignore | 0.20 | 1.00 | 1.00 | 0.25 | 0.43 | 4 | 4 |
| directory-summary | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 5 | 5 |
| config-loading | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 3 | 3 |
| cli-args | 0.20 | 1.00 | 1.00 | 0.20 | 0.39 | 5 | 4 |
| secret-detection | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 5 | 5 |
| postgres-vector | 0.20 | 0.50 | 0.50 | 1.00 | 0.61 | 5 | 5 |
| sqlite-vec0 | 0.20 | 1.00 | 1.00 | 0.20 | 0.39 | 5 | 4 |
| content-formatting | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 5 | 4 |
| post-commit-hook | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 4 | 3 |
| export-snapshot | 0.20 | 1.00 | 1.00 | 0.20 | 0.39 | 5 | 4 |
| scoring-commit-boost | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 3 |
| parent-dir-boost | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 5 | 3 |
| indexignore-override | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 5 | 5 |
| negative-kubernetes | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 2 | 2 |
| ambiguous-types | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 2 | 2 |
| cross-file-embedding-pipeline | 0.40 | 0.67 | 0.67 | 1.00 | 0.67 | 5 | 4 |
| prose-roadmap-milestones | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 5 | 4 |
| prose-schema-versioning-plan | 0.00 | 0.00 | 0.50 | 0.17 | 0.22 | 5 | 5 |
| prose-design-principles | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 2 | 2 |
| prose-mcp-server-plan | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 5 | 4 |
| prose-cost-tracking | 0.20 | 0.50 | 0.50 | 0.33 | 0.31 | 5 | 3 |
| prose-local-embeddings | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 5 | 4 |
| prose-intent-layer | 0.20 | 0.50 | 0.50 | 0.20 | 0.24 | 5 | 4 |
| kotlin-data-class | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 2 | 2 |
| kotlin-sealed-class | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 2 | 2 |
| kotlin-extension-function | 0.20 | 1.00 | 1.00 | 0.20 | 0.39 | 5 | 4 |
| kotlin-coroutine-suspend | 0.20 | 1.00 | 1.00 | 0.33 | 0.50 | 3 | 3 |
| kotlin-companion-object | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 3 | 3 |
| swift-protocol-conformance | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 3 | 3 |
| swift-struct-memberwise-init | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 3 | 3 |
| swift-enum-associated-values | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 2 | 2 |
| swift-async-await | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 5 | 4 |
| swift-property-wrapper | 0.20 | 1.00 | 1.00 | 0.33 | 0.50 | 3 | 3 |
| ruby-class-inheritance | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 3 | 3 |
| ruby-module-mixin | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 4 | 3 |
| ruby-block-yield | 0.20 | 1.00 | 1.00 | 0.33 | 0.50 | 5 | 5 |
| ruby-attr-accessor | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 4 | 4 |
| ruby-proc-lambda | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 5 | 4 |
| php-class-interface | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 2 | 2 |
| php-trait-usage | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 3 | 3 |
| php-namespace-use | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 4 | 4 |
| php-enum-backed | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 1 | 1 |
| php-constructor-promotion | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 3 |
| lua-table-constructor | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 2 | 2 |
| lua-closure-upvalue | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 4 | 4 |
| lua-coroutine-resume | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 2 | 2 |
| lua-module-require | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 4 | 4 |
| lua-metamethod-index | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 5 | 5 |
| scala-object-singleton | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 3 | 3 |
| scala-trait-definition | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 5 | 4 |
| scala-case-class | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 3 | 3 |
| scala-class-trait-impl | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 4 | 4 |
| scala-type-alias | 0.20 | 1.00 | 1.00 | 0.33 | 0.50 | 5 | 4 |
| prose-claude-instructions | 0.20 | 1.00 | 1.00 | 0.33 | 0.50 | 4 | 4 |
| prose-readme-overview | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 5 | 4 |
| prose-spec-architecture | 0.00 | 0.00 | 1.00 | 0.11 | 0.30 | 5 | 3 |
| prose-plan-milestones | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 5 | 5 |
| prose-ci-guide | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 4 | 4 |
| prose-tree-sitter-upgrade | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 5 | 5 |
| prose-skill-definition | 0.20 | 1.00 | 1.00 | 0.33 | 0.50 | 5 | 4 |
| prose-package-manager-bun | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 3 | 3 |