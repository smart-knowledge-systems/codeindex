# Eval Results: baseline

Run at: 2026-03-14T19:09:46.994Z

## Aggregate Metrics

| Metric | Value |
|--------|-------|
| Avg P@5 | 0.194 |
| Avg HitRate@5 | 0.851 |
| Avg Recall | 0.859 |
| Avg MRR | 0.735 |
| Avg nDCG@10 | 0.755 |
| Avg Unique Files in Top 5 | 4.37 |
| Avg Unique Dirs in Top 5 | 2.72 |

> **P@5** = hits in top 5 / 5 (standard). **HitRate@5** = hits in top 5 / min(5, expected) — more useful when most queries have 1 expected file.

## Per-Query Results

| Query | P@5 | HR@5 | Recall | MRR | nDCG | Files@5 | Dirs@5 |
|-------|-----|------|--------|-----|------|---------|--------|
| embedding-vector-search | 0.40 | 1.00 | 1.00 | 0.25 | 0.50 | 5 | 4 |
| tree-sitter-skeleton | 0.20 | 1.00 | 1.00 | 0.25 | 0.43 | 5 | 3 |
| git-commit-recency | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 2 |
| database-schema | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 4 |
| file-walking-gitignore | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 5 | 3 |
| directory-summary | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 2 |
| config-loading | 0.20 | 1.00 | 1.00 | 0.33 | 0.50 | 3 | 3 |
| cli-args | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 4 | 3 |
| secret-detection | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 4 | 2 |
| postgres-vector | 0.20 | 0.50 | 0.50 | 0.33 | 0.31 | 5 | 3 |
| sqlite-vec0 | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 3 |
| content-formatting | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 3 |
| post-commit-hook | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 3 | 3 |
| export-snapshot | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 5 | 4 |
| scoring-commit-boost | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 5 | 3 |
| parent-dir-boost | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 5 | 3 |
| indexignore-override | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 5 | 4 |
| negative-kubernetes | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0 | 0 |
| ambiguous-types | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 5 | 4 |
| cross-file-embedding-pipeline | 0.20 | 0.33 | 0.33 | 1.00 | 0.47 | 3 | 3 |
| prose-roadmap-milestones | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 2 |
| prose-schema-versioning-plan | 0.20 | 0.50 | 0.50 | 0.50 | 0.39 | 5 | 3 |
| prose-design-principles | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 1 | 1 |
| prose-mcp-server-plan | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 5 | 4 |
| prose-cost-tracking | 0.20 | 0.50 | 0.50 | 1.00 | 0.61 | 5 | 4 |
| prose-local-embeddings | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 4 | 2 |
| prose-intent-layer | 0.20 | 0.50 | 1.00 | 0.50 | 0.61 | 5 | 2 |
| kotlin-data-class | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 3 |
| kotlin-sealed-class | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 3 |
| kotlin-extension-function | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 5 | 3 |
| kotlin-coroutine-suspend | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 4 | 3 |
| kotlin-companion-object | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 3 |
| swift-protocol-conformance | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 3 | 3 |
| swift-struct-memberwise-init | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 2 |
| swift-enum-associated-values | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 4 | 2 |
| swift-async-await | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 3 | 3 |
| swift-property-wrapper | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 4 |
| ruby-class-inheritance | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 2 |
| ruby-module-mixin | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 4 |
| ruby-block-yield | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 4 | 3 |
| ruby-attr-accessor | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 2 | 2 |
| ruby-proc-lambda | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 2 | 2 |
| php-class-interface | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 1 |
| php-trait-usage | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 4 |
| php-namespace-use | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 4 |
| php-enum-backed | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 3 | 1 |
| php-constructor-promotion | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 2 |
| lua-table-constructor | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 5 | 3 |
| lua-closure-upvalue | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 3 | 2 |
| lua-coroutine-resume | 0.20 | 1.00 | 1.00 | 0.33 | 0.50 | 5 | 3 |
| lua-module-require | 0.20 | 1.00 | 1.00 | 0.33 | 0.50 | 5 | 4 |
| lua-metamethod-index | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 5 | 4 |
| scala-object-singleton | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 4 |
| scala-trait-definition | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 3 |
| scala-case-class | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 3 |
| scala-class-trait-impl | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 2 |
| scala-type-alias | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 4 |
| prose-claude-instructions | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 3 | 1 |
| prose-readme-overview | 0.20 | 1.00 | 1.00 | 0.20 | 0.39 | 5 | 1 |
| prose-spec-architecture | 0.20 | 1.00 | 1.00 | 0.25 | 0.43 | 5 | 2 |
| prose-plan-milestones | 0.20 | 1.00 | 1.00 | 0.50 | 0.63 | 3 | 1 |
| prose-ci-guide | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 4 | 3 |
| prose-tree-sitter-upgrade | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 4 | 3 |
| prose-skill-definition | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 1 |
| prose-package-manager-bun | 0.20 | 1.00 | 1.00 | 1.00 | 1.00 | 5 | 2 |