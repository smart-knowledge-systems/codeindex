# Ablation Study Results

Run at: 2026-03-13T19:23:34.139Z

## Aggregate Comparison

| Config | Avg P@5 | Avg Recall | Avg MRR |
|--------|---------|------------|---------|
| baseline | 0.842 | 0.858 | 0.752 |
| no-commit-boost | 0.625 | 0.675 | 0.633 |
| no-parent-boost | 0.792 | 0.858 | 0.745 |
| no-child-boost | 0.842 | 0.858 | 0.752 |
| pure-cosine | 0.625 | 0.675 | 0.632 |
| high-parent | 0.842 | 0.858 | 0.752 |

## Per-Query Breakdown

### baseline

| Query | P@5 | Recall | MRR |
|-------|-----|--------|-----|
| embedding-vector-search | 0.50 | 0.50 | 0.25 |
| tree-sitter-skeleton | 1.00 | 1.00 | 1.00 |
| git-commit-recency | 1.00 | 1.00 | 0.50 |
| database-schema | 1.00 | 1.00 | 1.00 |
| file-walking-gitignore | 1.00 | 1.00 | 1.00 |
| directory-summary | 1.00 | 1.00 | 1.00 |
| config-loading | 1.00 | 1.00 | 1.00 |
| cli-args | 1.00 | 1.00 | 0.50 |
| secret-detection | 1.00 | 1.00 | 1.00 |
| postgres-vector | 0.50 | 0.50 | 1.00 |
| sqlite-vec0 | 1.00 | 1.00 | 1.00 |
| content-formatting | 1.00 | 1.00 | 1.00 |
| post-commit-hook | 1.00 | 1.00 | 1.00 |
| export-snapshot | 1.00 | 1.00 | 1.00 |
| scoring-commit-boost | 1.00 | 1.00 | 0.20 |
| parent-dir-boost | 1.00 | 1.00 | 0.25 |
| indexignore-override | 1.00 | 1.00 | 1.00 |
| negative-kubernetes | 0.00 | 0.00 | 0.00 |
| ambiguous-types | 0.50 | 0.50 | 1.00 |
| cross-file-embedding-pipeline | 0.33 | 0.67 | 0.33 |

### no-commit-boost

| Query | P@5 | Recall | MRR |
|-------|-----|--------|-----|
| embedding-vector-search | 0.00 | 0.00 | 0.00 |
| tree-sitter-skeleton | 0.00 | 1.00 | 0.17 |
| git-commit-recency | 1.00 | 1.00 | 1.00 |
| database-schema | 1.00 | 1.00 | 1.00 |
| file-walking-gitignore | 1.00 | 1.00 | 1.00 |
| directory-summary | 1.00 | 1.00 | 1.00 |
| config-loading | 1.00 | 1.00 | 1.00 |
| cli-args | 1.00 | 1.00 | 1.00 |
| secret-detection | 1.00 | 1.00 | 1.00 |
| postgres-vector | 0.00 | 0.00 | 0.00 |
| sqlite-vec0 | 1.00 | 1.00 | 1.00 |
| content-formatting | 1.00 | 1.00 | 1.00 |
| post-commit-hook | 1.00 | 1.00 | 0.50 |
| export-snapshot | 1.00 | 1.00 | 1.00 |
| scoring-commit-boost | 0.00 | 0.00 | 0.00 |
| parent-dir-boost | 0.00 | 0.00 | 0.00 |
| indexignore-override | 1.00 | 1.00 | 1.00 |
| negative-kubernetes | 0.00 | 0.00 | 0.00 |
| ambiguous-types | 0.50 | 0.50 | 1.00 |
| cross-file-embedding-pipeline | 0.00 | 0.00 | 0.00 |

### no-parent-boost

| Query | P@5 | Recall | MRR |
|-------|-----|--------|-----|
| embedding-vector-search | 0.50 | 0.50 | 0.20 |
| tree-sitter-skeleton | 1.00 | 1.00 | 1.00 |
| git-commit-recency | 1.00 | 1.00 | 0.50 |
| database-schema | 1.00 | 1.00 | 1.00 |
| file-walking-gitignore | 1.00 | 1.00 | 1.00 |
| directory-summary | 1.00 | 1.00 | 1.00 |
| config-loading | 1.00 | 1.00 | 1.00 |
| cli-args | 1.00 | 1.00 | 0.50 |
| secret-detection | 1.00 | 1.00 | 1.00 |
| postgres-vector | 0.50 | 0.50 | 1.00 |
| sqlite-vec0 | 1.00 | 1.00 | 1.00 |
| content-formatting | 1.00 | 1.00 | 1.00 |
| post-commit-hook | 1.00 | 1.00 | 1.00 |
| export-snapshot | 1.00 | 1.00 | 1.00 |
| scoring-commit-boost | 0.00 | 1.00 | 0.13 |
| parent-dir-boost | 1.00 | 1.00 | 0.25 |
| indexignore-override | 1.00 | 1.00 | 1.00 |
| negative-kubernetes | 0.00 | 0.00 | 0.00 |
| ambiguous-types | 0.50 | 0.50 | 1.00 |
| cross-file-embedding-pipeline | 0.33 | 0.67 | 0.33 |

### no-child-boost

| Query | P@5 | Recall | MRR |
|-------|-----|--------|-----|
| embedding-vector-search | 0.50 | 0.50 | 0.25 |
| tree-sitter-skeleton | 1.00 | 1.00 | 1.00 |
| git-commit-recency | 1.00 | 1.00 | 0.50 |
| database-schema | 1.00 | 1.00 | 1.00 |
| file-walking-gitignore | 1.00 | 1.00 | 1.00 |
| directory-summary | 1.00 | 1.00 | 1.00 |
| config-loading | 1.00 | 1.00 | 1.00 |
| cli-args | 1.00 | 1.00 | 0.50 |
| secret-detection | 1.00 | 1.00 | 1.00 |
| postgres-vector | 0.50 | 0.50 | 1.00 |
| sqlite-vec0 | 1.00 | 1.00 | 1.00 |
| content-formatting | 1.00 | 1.00 | 1.00 |
| post-commit-hook | 1.00 | 1.00 | 1.00 |
| export-snapshot | 1.00 | 1.00 | 1.00 |
| scoring-commit-boost | 1.00 | 1.00 | 0.20 |
| parent-dir-boost | 1.00 | 1.00 | 0.25 |
| indexignore-override | 1.00 | 1.00 | 1.00 |
| negative-kubernetes | 0.00 | 0.00 | 0.00 |
| ambiguous-types | 0.50 | 0.50 | 1.00 |
| cross-file-embedding-pipeline | 0.33 | 0.67 | 0.33 |

### pure-cosine

| Query | P@5 | Recall | MRR |
|-------|-----|--------|-----|
| embedding-vector-search | 0.00 | 0.00 | 0.00 |
| tree-sitter-skeleton | 0.00 | 1.00 | 0.14 |
| git-commit-recency | 1.00 | 1.00 | 1.00 |
| database-schema | 1.00 | 1.00 | 1.00 |
| file-walking-gitignore | 1.00 | 1.00 | 1.00 |
| directory-summary | 1.00 | 1.00 | 1.00 |
| config-loading | 1.00 | 1.00 | 1.00 |
| cli-args | 1.00 | 1.00 | 1.00 |
| secret-detection | 1.00 | 1.00 | 1.00 |
| postgres-vector | 0.00 | 0.00 | 0.00 |
| sqlite-vec0 | 1.00 | 1.00 | 1.00 |
| content-formatting | 1.00 | 1.00 | 1.00 |
| post-commit-hook | 1.00 | 1.00 | 0.50 |
| export-snapshot | 1.00 | 1.00 | 1.00 |
| scoring-commit-boost | 0.00 | 0.00 | 0.00 |
| parent-dir-boost | 0.00 | 0.00 | 0.00 |
| indexignore-override | 1.00 | 1.00 | 1.00 |
| negative-kubernetes | 0.00 | 0.00 | 0.00 |
| ambiguous-types | 0.50 | 0.50 | 1.00 |
| cross-file-embedding-pipeline | 0.00 | 0.00 | 0.00 |

### high-parent

| Query | P@5 | Recall | MRR |
|-------|-----|--------|-----|
| embedding-vector-search | 0.50 | 0.50 | 0.25 |
| tree-sitter-skeleton | 1.00 | 1.00 | 1.00 |
| git-commit-recency | 1.00 | 1.00 | 0.50 |
| database-schema | 1.00 | 1.00 | 1.00 |
| file-walking-gitignore | 1.00 | 1.00 | 1.00 |
| directory-summary | 1.00 | 1.00 | 1.00 |
| config-loading | 1.00 | 1.00 | 1.00 |
| cli-args | 1.00 | 1.00 | 0.50 |
| secret-detection | 1.00 | 1.00 | 1.00 |
| postgres-vector | 0.50 | 0.50 | 1.00 |
| sqlite-vec0 | 1.00 | 1.00 | 1.00 |
| content-formatting | 1.00 | 1.00 | 1.00 |
| post-commit-hook | 1.00 | 1.00 | 1.00 |
| export-snapshot | 1.00 | 1.00 | 1.00 |
| scoring-commit-boost | 1.00 | 1.00 | 0.20 |
| parent-dir-boost | 1.00 | 1.00 | 0.25 |
| indexignore-override | 1.00 | 1.00 | 1.00 |
| negative-kubernetes | 0.00 | 0.00 | 0.00 |
| ambiguous-types | 0.50 | 0.50 | 1.00 |
| cross-file-embedding-pipeline | 0.33 | 0.67 | 0.33 |
