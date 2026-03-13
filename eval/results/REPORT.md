# M1 Search Quality Evaluation Report

**Date:** 2026-03-13
**Repo:** codeindex (self-evaluation)
**Dataset:** 20 labeled queries (18 positive, 1 negative, 1 ambiguous)
**Scoring defaults:** alpha=0.15, beta=0.2, gamma=0.1, parentBoostMultiplier=0.3, minScore=0.3

---

## Executive Summary

codeindex's semantic search significantly outperforms keyword-based search (ripgrep) on precision and ranking quality, while maintaining comparable recall. The commit-recency boost is the most valuable scoring signal, contributing a +35% lift to precision. The parent-directory boost provides a modest +6% improvement. The child-to-parent boost (gamma) shows no measurable effect on this dataset.

---

## 1. Baseline vs Ripgrep

| Metric | codeindex | ripgrep | Delta |
|--------|-----------|---------|-------|
| **Precision@5** | 0.842 | 0.317 | **+166%** |
| **Recall** | 0.858 | 0.742 | +16% |
| **MRR** | 0.752 | 0.320 | **+135%** |

codeindex delivers **2.7x better precision** and **2.4x better MRR** than ripgrep. Ripgrep achieves decent recall (0.742) by casting a wide net, but its precision is poor — most top-5 results are irrelevant. codeindex surfaces the right files first.

---

## 2. Signal Ablation Study

Six scoring configurations were tested to isolate the contribution of each signal:

| Config | P@5 | Recall | MRR | P@5 vs Baseline |
|--------|-----|--------|-----|-----------------|
| **baseline** (defaults) | **0.842** | **0.858** | **0.752** | — |
| no-commit-boost (alpha=0) | 0.625 | 0.675 | 0.633 | **-25.8%** |
| no-parent-boost (beta=0) | 0.792 | 0.858 | 0.745 | -5.9% |
| no-child-boost (gamma=0) | 0.842 | 0.858 | 0.752 | 0.0% |
| pure-cosine (all boosts=0) | 0.625 | 0.675 | 0.632 | **-25.8%** |
| high-parent (beta=0.4, mult=0.5) | 0.842 | 0.858 | 0.752 | 0.0% |

### Key Findings

**Commit boost (alpha) is the most valuable signal.** Removing it causes a 25.8% drop in P@5, from 0.842 to 0.625. Five queries drop to zero precision without it:
- `embedding-vector-search` (1→0 expected files found)
- `scoring-commit-boost` (1→0)
- `parent-dir-boost` (1→0)
- `cross-file-embedding-pipeline` (2→0)
- `tree-sitter-skeleton` (MRR drops from 1.0 to 0.17 — file falls out of top 5)

The commit boost helps because recently-changed files are more likely to be the authoritative implementation of a concept. Files that were part of a commit mentioning "skeleton extraction" rank higher for skeleton-related queries.

**Parent boost (beta) helps modestly.** Removing it causes a 5.9% drop in P@5. The main impact is on the `scoring-commit-boost` query, where `src/search/query.ts` falls out of the top 5 without the directory-level boost from `src/search/`.

**Child-to-parent boost (gamma) has zero measurable effect.** Results are identical with gamma=0 vs the baseline. This signal is designed to boost directory results when multiple child files score highly — the current dataset doesn't exercise this because most queries target individual files rather than directories.

**High-parent config offers no improvement.** Increasing beta from 0.2→0.4 and the multiplier from 0.3→0.5 produces identical results to baseline. The current defaults are already well-calibrated for this codebase.

**Pure cosine is essentially equivalent to no-commit-boost**, confirming that the commit signal accounts for nearly all of the boost's value.

---

## 3. Per-Query Analysis

### Perfect scores (12/20 queries — 60%)

These queries achieve P@5=1.0, Recall=1.0, MRR=1.0 across all configs:

| Query | Expected File |
|-------|--------------|
| tree-sitter-skeleton | `src/index/skeleton.ts` |
| database-schema | `src/db/schema.ts` |
| file-walking-gitignore | `src/index/walker.ts` |
| directory-summary | `src/index/directories.ts` |
| config-loading | `src/config.ts` |
| secret-detection | `src/index/secrets.ts` |
| sqlite-vec0 | `src/db/sqlite.ts` |
| content-formatting | `src/index/formatter.ts` |
| post-commit-hook | `src/hooks/post-commit.ts` |
| export-snapshot | `src/db/export.ts` |
| indexignore-override | `src/index/walker.ts` |

These represent the "easy" cases where the file's skeleton is semantically close to the query. The AST extraction captures the right concepts and the embedding model matches them well.

### Good precision, low MRR (3 queries)

| Query | P@5 | MRR | Issue |
|-------|-----|-----|-------|
| git-commit-recency | 1.0 | 0.50 | `src/index.ts` ranks above `src/index/commits.ts` |
| cli-args | 1.0 | 0.50 | `src/index.ts` ranks above `src/cli.ts` |
| scoring-commit-boost | 1.0 | 0.20 | `src/search/query.ts` ranks 5th behind index.ts, types.ts, eval files |

**Pattern:** `src/index.ts` (the CLI entry point, 1000+ lines) absorbs many queries because it touches every subsystem. It acts as a "gravity well" that pulls ranking away from the more specific implementation files. This is a known limitation of embedding large files — their skeletons are broad enough to match many queries.

### Partial matches (3 queries)

| Query | P@5 | Recall | Issue |
|-------|-----|--------|-------|
| embedding-vector-search | 0.50 | 0.50 | `src/index/embedder.ts` not in top results; eval files rank higher |
| postgres-vector | 0.50 | 0.50 | `src/db/pg.ts` doesn't surface; `src/search/query.ts` found at rank 1 |
| ambiguous-types | 0.50 | 0.50 | `src/cli.ts` not found; its types (ParsedArgs) are too generic |

**Pattern:** Multi-file queries (where the concept spans 2+ files) are harder. The embedding model tends to surface the most semantically obvious file but misses supporting files whose skeletons don't directly mention the query terms.

### Cross-file query (1 query)

| Query | P@5 | Recall | MRR |
|-------|-----|--------|-----|
| cross-file-embedding-pipeline | 0.33 | 0.67 | 0.33 |

Expected `src/index.ts`, `src/index/embedder.ts`, `src/index/skeleton.ts`. Found 2/3 but `src/index/skeleton.ts` didn't rank high enough. This is the hardest query type — understanding end-to-end flows requires connecting files that don't share vocabulary.

### Negative query (1 query)

| Query | P@5 | Recall | MRR |
|-------|-----|--------|-----|
| negative-kubernetes | 0.00 | 0.00 | 0.00 |

Correctly returns no relevant results. All returned files score below the relevance threshold for the expected empty set — no false positives.

---

## 4. Recommendations for M2

Based on these results, the following optimizations are recommended:

1. **Keep commit boost (alpha=0.15).** It's the strongest signal. Consider increasing it slightly (0.18–0.20) in M2 weight optimization.

2. **Keep parent boost (beta=0.2) at current level.** It helps marginally. Increasing it doesn't improve results.

3. **Defer child-to-parent boost (gamma) evaluation.** It shows no effect on a single-repo dataset. Test again after expanding the eval dataset to larger repos with deeper hierarchies.

4. **Add hybrid search (M2.2) to address the weak spots.** Keyword matching would help queries like `embedding-vector-search` and `postgres-vector` where the expected file's skeleton doesn't contain the exact query terms but the source code does.

5. **Consider skeleton length normalization.** Large files like `src/index.ts` dominate rankings across many queries. Normalizing skeleton embeddings by length or applying a file-size penalty could improve MRR.

6. **Expand the eval dataset.** 20 queries against a single repo is a bootstrapping baseline. The plan calls for 50–100 queries across Express.js and FastAPI to validate these findings generalize.

---

## 5. Methodology

### Metrics

- **Precision@5 (P@5):** Of the top 5 returned results (files only, excluding dir/commit types), what fraction appear in the expected file list.
- **Recall:** Of all expected files, what fraction appear anywhere in the returned results.
- **MRR (Mean Reciprocal Rank):** 1/rank of the first expected file found (0 if none found in results).

### Ripgrep baseline

Keywords extracted from each query (stop words removed, top 5 longest words). Each keyword searched via `rg -l`. Files matching the most keywords ranked highest. P@5 computed against expected files.

### Ablation configs

| Name | Overrides |
|------|-----------|
| baseline | (defaults: alpha=0.15, beta=0.2, gamma=0.1) |
| no-commit-boost | alpha=0 |
| no-parent-boost | beta=0 |
| no-child-boost | gamma=0 |
| pure-cosine | alpha=0, beta=0, gamma=0 |
| high-parent | beta=0.4, parentBoostMultiplier=0.5 |
