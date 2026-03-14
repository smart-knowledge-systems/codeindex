# ROADMAP — codeindex

> **Status: Complete (2026-03-14)**
> This document is now a historic artifact recording the product backlog that guided codeindex development from inception through M6. All milestones have been substantially completed. See [WHATS_NEXT.md](WHATS_NEXT.md) for remaining work.

Ordered product backlog organized by milestone. Each milestone is a themed group of work that delivers a coherent increment of value. Items within milestones are ordered by dependency and priority.

**Target users**: AI-augmented developers, developer tooling teams, power users across large/unfamiliar codebases.

---

## Milestone 0: Solid Ground (Foundation + Onboarding)
*Goal: Make what we have actually work reliably for new users on both backends. A new user should be able to go from `git clone` to search results in under 5 minutes on SQLite with no external dependencies beyond an OpenAI key.*

| # | Item | Description | Champions | Size | Status |
|---|------|-------------|-----------|------|--------|
| 0.1 | `codeindex init` command | Scaffold config, detect backend, create schema — the entry point that doesn't exist yet | dx-engineer | S | Done |
| 0.2 | SQLite write path (must-fix 3) | Implement repo upsert, reindex write path, and status for SQLite — ~80-120 lines following existing PG patterns | dx-engineer, platform-engineer | S | Done |
| 0.3 | Transaction wrapper for index pipeline | Wrap file/commit upsert loops in transactions so interrupted reindex doesn't leave partial state | platform-engineer | S | Done |
| 0.4 | Content-hash dedup hardening | Ensure content_hash skip works correctly on both backends so re-runs are cheap and idempotent | platform-engineer, cost-economist | S | Done |
| 0.5 | CLI arg parsing + error messages + `codeindex doctor` | Proper CLI argument parsing (not manual argv slicing), actionable errors for missing deps, and a `doctor` subcommand that validates the environment | dx-engineer | M | Done |
| 0.6 | Pre-embedding secret scanning | Scan file content for high-entropy strings, API keys, and common secret patterns before sending to OpenAI; skip or warn | security-reviewer | S | Done |
| 0.7 | `.indexignore` hardening | Respect .indexignore (and .gitignore) consistently across all commands; ensure sensitive paths (`.env`, credentials) are excluded by default | security-reviewer | S | Done |
| 0.8 | Migration file discipline | Record every DDL change as a numbered `.sql` file in `migrations/` — no automated runner yet, but establishes the history that M3's runner will consume | platform-engineer | S | Done |

**Exit criteria**: `codeindex init && codeindex reindex && codeindex search "auth"` works on SQLite with no PG required. Results are reliable and repeatable. Secrets are not sent to embedding APIs. All schema changes are tracked.

---

## Milestone 1: Measure + Differentiate
*Goal: Establish quality baselines, ship the Intent Layer (our differentiator), and add the lightweight plumbing that unblocks multi-repo users and agent consumers.*

| # | Item | Description | Champions | Size | Status |
|---|------|-------------|-----------|------|--------|
| 1.1 | Eval dataset (~50-100 labeled queries + ~20 summary assessments + ripgrep baseline) | Curate benchmark queries with expected results across 2-3 open-source repos; measure precision@5, recall, MRR; include ripgrep comparison as baseline; grade ~20 directory summaries on accuracy, completeness, and navigability as quality gate for intent | search-quality, skeptical-adopter | M | Done |
| 1.2 | Baseline scoring evaluation | Run current scoring formula against eval dataset, publish results, identify weaknesses | search-quality | S | Done |
| 1.3 | Signal ablation study | Test alpha=0 (no commit boost) and beta=0 (no parent boost) against defaults; determine if existing signals help or hurt; expose hardcoded 0.3 parentBoost multiplier as config | search-quality | S | Done |
| 1.4 | `codeindex intent [--out AGENTS.md]` | Generate Intent Node drafts from directory summaries — the differentiator; includes lightweight summary quality check (~20 directory assessments as part of eval dataset) | product-owner, agent-developer | M | Done |
| 1.5 | `codeindex drift [--threshold 0.3]` | Detect stale Intent Nodes by comparing directory summary embeddings against existing AGENTS.md content embeddings | product-owner, agent-developer | M | Done |
| 1.6 | Line-number and snippet results | Search results include start/end line numbers and optional code snippets so agents can jump directly to relevant code without a second Read call | agent-developer | S | Done |
| 1.7 | Skill file (agent documentation) | Ship a skill file documenting the schema, query patterns, and `db.unsafe()` escape hatch so agents can use codeindex programmatically via raw SQL before the full API ships | agent-developer, product-owner | S | Done |
| 1.8 | Repo management CLI (`repo add/remove/list/status`) + data purge | Lightweight plumbing for multi-repo on PG; includes `repo purge` to completely remove a repo's data from the index | multi-repo-user, security-reviewer | S | Done |
| 1.9 | Cost tracking (`status --cost`) | Show embedding/summary token spend per repo, cumulative costs, projected reindex cost, dry-run mode | cost-economist, product-owner | M | Done |

**Exit criteria**: Empirical data on search quality with ripgrep comparison. Ablation results inform which signals to keep. `intent` and `drift` work for single-repo happy path. Agents can use codeindex via skill file + raw SQL. Multi-repo users can manage repos and purge data. Cost visibility is live.

---

## Milestone 2: Search Quality + Agent Integration
*Goal: Make search results meaningfully better (validated by data), ship the full agent API, and add the controls that prevent churn.*

| # | Item | Description | Champions | Size | Status |
|---|------|-------------|-----------|------|--------|
| 2.1 | Scope filtering (language, directory, recency) | `--lang ts --dir src/api --since 30d` filters that push down to SQL for performance; this is table-stakes for competing with grep+find | agent-developer, skeptical-adopter | M | Done |
| 2.2 | Hybrid search (semantic + keyword) | Add BM25/keyword matching alongside vector similarity; combine scores with tunable weight; validate improvement against eval dataset | search-quality, skeptical-adopter | L | Done |
| 2.3 | Scoring weight optimization | Use eval dataset + ablation results from M1.3 to optimize alpha/beta/gamma weights and minScore thresholds post-hybrid-search | search-quality | S | Done |
| 2.4 | `--explain` flag for scoring transparency | Show per-result score breakdown (semantic similarity, commit boost, parent boost, keyword match) so users can understand and trust rankings | skeptical-adopter, search-quality | S | Done |
| 2.5 | Agent-native API surface (db-harness) | Polish typed query functions (`search`, `searchFiles`, `searchDirectories`, `searchCommits`) that complement the M1.7 skill file; now exposes hybrid search and scope filtering | agent-developer, product-owner | M | Done |
| 2.6 | Cross-repo result attribution | Search results clearly show which repo each result comes from; `--scope all` is the default when multiple repos are indexed — mostly display logic, cheap to ship | multi-repo-user, product-owner | S | Done |
| 2.7 | HNSW vector indexes | Add approximate nearest neighbor indexes on PG (pgvector HNSW) and SQLite (sqlite-vec) to handle repos with 10k+ files | platform-engineer, multi-repo-user | M | Done |
| 2.8 | Cost caps and dry-run budgets | Hard limits on token spend per reindex; pause and prompt when approaching cap; `--dry-run` shows projected cost before committing | cost-economist | S | Done |
| 2.9 | Skeleton extraction test suite | Automated tests for all 9 supported languages verifying skeleton accuracy; catches regressions before they pollute embeddings | language-advocate | S | Done |
| 2.10 | SQLite incremental update path | Implement `cmdUpdate` for SQLite so post-commit hooks work on the portable backend | dx-engineer | S | Done |

**Exit criteria**: Hybrid search measurably improves precision/recall vs. baseline. Scope filtering works. Agents have a full typed API. Cross-repo results are attributed. Cost controls prevent bill shock. Search stays fast at scale.

---

## Milestone 3: Adoption + Distribution
*Goal: Remove the remaining barriers to adoption (local embeddings, CI/CD, cost reduction) while simultaneously opening the agent distribution channel (MCP). Ship the safety infrastructure everything depends on (migrations).*

**Why two parallel workstreams:** M0-M2 retrospective surfaced a core tension — some users need adoption barriers removed (local embeddings, CI/CD, cost), while agent ecosystems need distribution and scale (MCP, parallel reindex). These are largely independent. Rather than force a single ordering, M3 is organized as two concurrent tracks sharing a common foundation.

**Pre-M3 bug fix:** Three independent reviewers found ~80% empty results on conceptual queries against the codeindex repo itself. Investigate and fix prose/markdown indexing coverage before starting M3. Add zero-result search diagnostics (grep fallback suggestion, `codeindex doctor` hint) as a trust-preserving baseline.

### Foundation (ships first — both tracks depend on these)

| # | Item | Description | Champions | Size | Status |
|---|------|-------------|-----------|------|--------|
| 3.1 | Schema versioning + automated migrations | Forward-only migration runner consuming numbered `.sql` files from M0.8. `schema_version` tracking (PG table, SQLite `PRAGMA user_version`). `doctor` warns on mismatch. Auto-migrate on `init`. Resolves M0.8 gap. Must land first — caching needs a schema change, MCP consumers need schema stability | platform-engineer, dx-engineer | M | Done |
| 3.2 | Directory summary dedup/caching + batch API | Cache directory summaries by content hash of child files. Skip Haiku re-summarization when children haven't changed — eliminates ~90% of summary costs on incremental reindex. Batch directory embeddings into single API calls. Consider Anthropic Batch API for summaries (50% cost reduction, inspired by audit system's `pricing.ts`). Depends on M3.1 for `children_hash` column | cost-economist, platform-engineer | S | Done |
| 3.3 | Language construct gaps (existing 9 languages) | Fix missing constructs: TS interfaces/type aliases/enums, Python decorators, Java annotations, Rust derive/macros, C# attributes/properties, Go constant groups, C++ templates, C typedefs. Prioritized by user base. M2.9 test suite makes this safe. Independent of other M3 work | language-advocate, search-quality | M | Done |

### Track A: Adoption (reduces barriers for new users)

| # | Item | Description | Champions | Size | Status |
|---|------|-------------|-----------|------|--------|
| 3.4 | Embedding model comparison framework | Harness that runs eval dataset against multiple models, measuring nDCG/MRR/P@5 and cost per 1K files. Prerequisite for M3.6 — ships quality data, not faith. Small: parameterize existing eval runner on embedding model | search-quality | S | Done |
| 3.5 | CI/CD integration + export redaction | SQLite export for read-only CI use with default-on redaction: `--redact-embeddings`, `--redact-commits`, `--exclude-patterns`. Export respects `.indexignore`. Includes CI guide and `--read-only` mode. The adoption multiplier: one person sets up CI, every developer on the team gets codeindex | dx-engineer, security-reviewer | S | Done |
| 3.6 | Local/pluggable embedding backend | Support local models (nomic-embed via Ollama) as alternative to OpenAI. Eliminates API costs and the "I have to send my code to OpenAI?" adoption blocker. Addresses data-sovereignty for regulated industries. Scoped: provider interface + Ollama, no mixed-provider indexes, full re-embed on switch. Definition-of-done includes comparison framework results (M3.4) proving no quality regression | cost-economist, security-reviewer, skeptical-adopter | L | Done |

### Track B: Distribution (gets codeindex into agent ecosystems + multi-repo scale)

| # | Item | Description | Champions | Size | Status |
|---|------|-------------|-----------|------|--------|
| 3.7 | MCP server mode | Persistent MCP server exposing `search`, `intent`, `drift`, `status` as tools. Thin transport over existing `src/api.ts`. Eliminates 200-500ms CLI startup overhead. Supports stdio and SSE transports. Include result staleness metadata (`indexedAt`, `stale` flag). The distribution channel: agents in Claude Code, Cursor, Windsurf discover codeindex via MCP | agent-developer, product-owner | M | Done |
| 3.8 | Parallel reindex (PG-first) | `reindex --scope all` indexes repos concurrently. Queue-based with `--workers N` (default 3). Pre-allocated per-worker cost budgets from global cap. Failure isolation per repo. Per-repo progress and `--dry-run` cost breakdown. PG connection pool configurable. SQLite parallel = separate DB files only | multi-repo-user, platform-engineer, cost-economist | M | Done |
| 3.9 | Structured import graph indexing | Extract import/export edges from tree-sitter skeletons into `file_imports` table (source_file, imported_module, resolved_file_path). Per-language resolution for TS/JS, Python, Go, Rust, Java. Enables "find callers" queries. Foundation for M4.1 cross-repo relationships. Pairs with M3.3 construct work — same extractors being touched | language-advocate, agent-developer, multi-repo-user | M | Done |

### Additional M3 Items (independent, ship alongside either track)

| # | Item | Description | Champions | Size | Status |
|---|------|-------------|-----------|------|--------|
| 3.10 | Audit trail / index manifest | `codeindex manifest` command reporting what was indexed, skipped, and flagged by secret scanning. Structured JSON output for security team verifiability | security-reviewer | S | Done |
| 3.11 | Skeleton length normalization | Address "gravity well" where large files dominate rankings for unrelated queries. Normalize embedding similarity by skeleton token count or apply file-size penalty. Validated against eval dataset | search-quality | S | Done |
| 3.12 | Result staleness flag | Lightweight `stale: boolean` on search results comparing `indexed_at` against file mtime. Helps agents decide whether to trust a result. ~20-line change | agent-developer | S | Done |

**Exit criteria:** Users can index without an OpenAI API key (local embeddings). CI pipelines produce safe, redacted SQLite exports. Incremental reindex costs drop 90%+ via summary caching. Agents discover codeindex via MCP. Teams with 5-10 repos can parallel reindex with pre-allocated budgets. Import graph enables "find callers" queries. Schema upgrades are automated.

### Workstream dependencies

```
M3.1 (migrations) ──┬──→ M3.2 (caching) ──→ [both tracks unblocked]
                     │
                     ├──→ Track A: M3.4 (eval framework) → M3.6 (local embeddings)
                     │                   M3.5 (CI/CD + export) [independent]
                     │
                     └──→ Track B: M3.7 (MCP) [independent]
                                   M3.8 (parallel reindex) [independent]
                                   M3.9 (import graph) [depends on M3.3]

M3.3 (construct gaps) ──→ M3.9 (import graph)
M3.10-3.12: independent, ship anytime
```

---

## Milestone 4: Cross-Repo Intelligence + Polish
*Goal: Ship the cross-repo differentiator, expand language coverage, add enterprise controls, and build the quality feedback loop.*

| # | Item | Description | Champions | Size | Status |
|---|------|-------------|-----------|------|--------|
| 4.1 | Cross-repo relationship discovery | Build on M3.9 import graph + M1.8 repo registry to detect cross-repo import/dependency relationships. `cross_repo_edges` table. Surface "this repo depends on that repo" in search results. Start with TS/JS, Python. The moat — no competitor surfaces cross-repo dependency intelligence | multi-repo-user, product-owner | M | Done |
| 4.2 | New language extractors (top 5) | Add Kotlin, Swift, Ruby, PHP, Lua — prioritized by ecosystem size and demand. Each gets skeleton extraction + test coverage. Remaining languages (Scala, Dart, Zig, Elixir, Elm, Objective-C) deferred to M5+. *Actual count reached 18 with Scala in M5.16, Zig in M6.1, and Elixir in M6.2.* | language-advocate | L | Done |
| 4.3 | Cross-repo eval dataset expansion | Expand from ~20 queries on 1 repo to 50-100 queries across 2-3 open-source repos. Multi-language coverage. Validates M3 features don't regress quality. Prerequisite for quality policies (M4.5) | search-quality, skeptical-adopter | M | Done |
| 4.4 | `codeindex check` — policy-based health validation | Inspired by audit system's policy auto-discovery pattern. Declarative health policies: index freshness, summary completeness, skeleton extraction failures, secret scan coverage. Runs as CI gate | dx-engineer, security-reviewer | M | Done |
| 4.5 | Search quality policy framework | Declarative quality assertions ("P@5 >= 0.80 on eval dataset"). Regression gate for scoring changes. Per-signal policies validated by ablation. Requires M4.3 eval data. Inspired by audit `policies/` pattern | search-quality | M | Not built |
| 4.6 | Lightweight access control for shared PG | Repo-level visibility via application-level scoped tokens (lighter than full RLS). `db.unsafe()` respects repo scope. Groundwork laid in M3.1 schema migrations | security-reviewer, platform-engineer | M | Done |
| 4.7 | Per-language scoring profiles | Language-specific alpha/beta/gamma weight overrides. Go (packages = directories) benefits from parent boost more than Java (deep mechanical hierarchies). Requires M4.3 cross-repo eval data | language-advocate, search-quality | S | Partial (config exists, no default profiles shipped) |

**Exit criteria:** Cross-repo relationships surface in search results. Language coverage reaches 14 languages (ultimately reached 18 — see Post-Implementation Notes). Index health is policy-validated. Search quality has a CI regression gate. Shared PG instances have access boundaries. Scoring is language-aware.

---

## Pre-M5 Bug Fixes (ship immediately, no milestone slot)

| # | Item | Size | Source | Status |
|---|------|------|--------|--------|
| — | Fix stale Haiku pricing constants in cost.ts ($0.25→$1.00 input, $1.25→$5.00 output) | XS | 4x underestimation breaks cost caps | Fixed |
| — | Fix SSE transport single-connection overwrite (transport.ts:20 — Map keyed by session ID) | XS | Blocks multi-agent MCP | Fixed |
| — | Fix cross_repo_edges full-table wipe → per-repo scoped delete on reindex | XS | Correctness bug | Fixed |

---

## Milestone 5: Architecture Intelligence
*Goal: Surface the cross-repo intelligence data built in M3-M4 through agent-native and human-native interfaces. Harden the platform for multi-agent concurrent usage. Make codeindex the tool that understands your architecture, not just your files.*

**Narrative**: M0-M2 built the search engine. M3 opened the distribution channel (MCP). M4 built the differentiator (cross-repo intelligence). M5 makes that intelligence accessible, secure, and fast — through authenticated MCP tools, CLI commands, and quality-validated retrieval improvements.

### M5.0 — Foundation (ships first, ~2-3 weeks)

*No new capabilities until these ship. All items are S-sized except MCP auth (M).*

#### Security Foundation

| # | Item | Description | Champions | Size | Status |
|---|------|-------------|-----------|------|--------|
| 5.0.1 | MCP authentication + token enforcement | Validate `CODEINDEX_TOKEN` per MCP session. SSE requires `Authorization: Bearer` header. All tools filter by token's repo scope. Reject out-of-scope `repoPath` params. | security-reviewer | M | Done |
| 5.0.2 | Cross-repo edge scoping | Filter `cross_repo_edges` by token scope — both source and target repo must be in scope | security-reviewer | S | Done |
| 5.0.3 | SSE transport hardening | Auth headers, CORS origin allowlist, rate limiting on `/message` endpoint | security-reviewer | S | Done |
| 5.0.4 | Secret scanner expansion | Slack (xoxb/xoxp), Google (AIza), JWT (eyJ), Azure, Stripe (sk_live/pk_live), Twilio, SendGrid, Datadog | security-reviewer | S | Done |

#### DX Foundation

| # | Item | Description | Champions | Size | Status |
|---|------|-------------|-----------|------|--------|
| 5.0.5 | `codeindex mcp-config` | Print JSON config for Claude Code / Cursor / Windsurf MCP integration | dx-engineer | XS | Done |
| 5.0.6 | CLI polish | Per-subcommand `--help`, unknown flag warnings, `--version`, zero-result diagnostics with rg fallback suggestion | dx-engineer | S | Done |
| 5.0.7 | `config --list` | Show all tunable knobs with current values | dx-engineer | XS | Done |
| 5.0.8 | Structured error codes | Machine-parseable error responses for MCP and CLI | dx-engineer | S | Done |

#### Quality + Observability Foundation

| # | Item | Description | Champions | Size | Status |
|---|------|-------------|-----------|------|--------|
| 5.0.9 | Opt-in usage telemetry | Local-only, off by default. Query patterns, tool usage, latency, cache hits. Exportable for analysis | skeptical-adopter | S | Done |
| 5.0.10 | Eval dataset maintenance protocol | Re-validate labels each milestone, add 10-20 queries, retire stale queries, automate staleness detection | search-quality | S | Done |
| 5.0.11 | Backfill per-language eval queries | 5 queries min per M4 language (Kotlin, Swift, Ruby, PHP, Lua). Prerequisite for all language work | language-advocate, search-quality | S | Done |
| 5.0.12 | Quality dashboard (`status --quality`) | Surface P@5, MRR, nDCG alongside cost metrics in `codeindex status` | search-quality | S | Not built |
| 5.0.13 | Retrieval diversity metric | Track unique-files-in-top-5 and unique-directories-in-top-5 in eval framework | search-quality | S | Done |

#### Infrastructure Foundation

| # | Item | Description | Champions | Size | Status |
|---|------|-------------|-----------|------|--------|
| 5.0.14 | Migration checksums | SHA-256 of migration file contents in `schema_version`. `doctor` verifies checksums match | platform-engineer | S | Done |
| 5.0.15 | SQLite migration transaction safety | Wrap SQLite DDL migrations in transactions | platform-engineer | S | Done |
| 5.0.16 | Structured event logging | Wide-event JSON logging (audit pattern). Reindex, search, embed, migrate events with duration_ms | platform-engineer | S | Done |
| 5.0.17 | MCP health endpoint | `health` tool returning schema version, connection status, index freshness, last reindex timestamp | platform-engineer | XS | Done |
| 5.0.18 | Configurable PG connection pool | `CODEINDEX_PG_MAX_CONNECTIONS` env var, default 20. Sizing guidance for concurrent agents | platform-engineer | S | Done |

**Exit criteria**: MCP is authenticated. Pricing is accurate. Telemetry collecting. DX gaps closed. Eval dataset maintained. Event logging live. Connection pool tunable.

### M5 Core — Architecture Intelligence (three parallel tracks)

#### Track A: Agent Ecosystem (MCP-facing)

| # | Item | Description | Champions | Size | Gate | Status |
|---|------|-------------|-----------|------|------|--------|
| 5.1 | Session-aware MCP with embedding cache | LRU embedding cache keyed by exact query text hash (no semantic similarity in v1 — deterministic and debuggable). Server-level, shared across sessions for multi-agent dedup. 30-min TTL. Caching only — no query rewriting without eval validation | agent-developer, product-owner | M | Scale benchmark: memory at 100 cached queries | Done |
| 5.2 | Import graph + cross-repo MCP tools | `getImporters`, `getDependencies`, `traceImportChain`, `getCrossRepoEdges`, `findImplementors`, `findCallers`. Pure SQL over existing tables. | agent-developer, product-owner | S | 5.0.1 (MCP auth) | Done |
| 5.3 | Batch query support | Multiple related queries in one MCP call. Shared embedding computation. Stacks with session cache. | agent-developer | S | Quality neutral | Done |
| 5.4 | Agent-initiated reindex triggers | `reindexFiles(paths[])` MCP tool. Max 50 files/call, max 5 calls/min/session. Respects M2.8 cost caps. Path traversal validation. | agent-developer, platform-engineer | S | 5.0.1 (MCP auth) | Done |
| 5.5 | Change-aware search | `searchChanged(since, query?)` — files modified since timestamp, optionally filtered by semantic query. | agent-developer | S | — | Done |

#### Track B: Cross-Repo Intelligence (CLI + Quality)

| # | Item | Description | Champions | Size | Gate | Status |
|---|------|-------------|-----------|------|------|--------|
| 5.6 | Scale benchmark (50K+ files) | Validate search quality and latency on large repos. All existing eval is on ~50-file repos | search-quality, skeptical-adopter | M | — | Partial (harness exists, not executed on 50K+ repo) |
| 5.7 | Prose/documentation search fix | HitRate@5=0.286 on prose queries is broken. Fix markdown/docs indexing, skeleton generation, or embedding quality for non-code content | search-quality | M | HitRate@5 >= 0.70 for prose queries | Done |
| 5.8 | MRR regression forensics | Investigate 38% MRR drop M1→M3. Harden quality policy framework gates. Establish regression alerting | search-quality | S | MRR restored to M1 baseline | Done |
| 5.9 | Cross-repo retrieval eval | 20-30 cross-boundary queries. Validates M4.1 edges improve search | search-quality, skeptical-adopter | M | P@5 >= 0.80 for cross-boundary results | Partial (dataset exists, not executed) |
| 5.10 | `codeindex xref <symbol>` | Cross-repo symbol resolution. "Show every consumer of UserDTO across all repos." CLI + JSON output | multi-repo-user, product-owner | M | 5.9 (cross-repo eval must pass) | Done |
| 5.11 | `codeindex graph` | Dependency DAG from cross_repo_edges. JSON, Mermaid, DOT output formats | multi-repo-user | S | — | Done |
| 5.12 | Import resolution: Go + Ruby + Kotlin/Java | Extend `resolveImport()` for three language families. Go: package→directory. Ruby: require_relative. Kotlin/Java: classpath convention | language-advocate | S-M | >80% resolution rate per language | Done |
| 5.13 | M4 extractor fixes | Ruby `attr_accessor`/`attr_reader`. PHP 8 attributes, enums, readonly properties. Swift `typealias` + `@available` | language-advocate | S | Per-language eval must not regress >2% | Done |

#### Track C: Cost + Infrastructure

| # | Item | Description | Champions | Size | Gate | Status |
|---|------|-------------|-----------|------|------|--------|
| 5.14 | Migrate summaries to Anthropic SDK + Batch API | Replace `claude --print` subprocess per directory with Anthropic SDK + Batch API. 50% cost reduction on summaries. Proper token counting | cost-economist | M | — | Partial (SDK done, batch not wired into directory pipeline) |
| 5.15 | Shared skeleton utilities + format contract | Extract duplicated helpers from skeleton.ts. Document skeleton format. Foundation for new languages | language-advocate | S | — | Done |
| 5.16 | Scala extractor | One new language with clear demand (Spark/data engineering). Uses shared utilities from 5.15 | language-advocate | S-M | 5 eval queries, skeleton test coverage | Done |
| 5.17a | Full RLS Phase 1: core tables | RLS on files, directories, commits, cost_events (4 tables with direct `repo_id`). 8 policies using `SET LOCAL app.current_repo_ids`. `CODEINDEX_RLS_DISABLED=1` escape hatch for single-user. `codeindex_admin` role bypasses RLS. `codeindex doctor` verifies RLS policies | security-reviewer, platform-engineer | S-M | Eval passes with RLS enabled, no result count changes | Done |
| 5.17b | Full RLS Phase 2: join-dependent tables | RLS on file_commits, file_imports, cross_repo_edges. Subquery policies (`source_file_id IN (SELECT id FROM files)`). Bidirectional edge scoping. Performance benchmarks required | security-reviewer, platform-engineer | S | Phase 1 passes, no query regression >5% | Done |
| 5.18 | Embedding dimension flexibility | `embedding_dimension` in repos table or config. Parameterized vec table creation. Prerequisite for future model diversity | platform-engineer | M | — | Done |

### Workstream dependencies

```
Pre-M5 bugs ──→ M5.0 (foundation) ──┬──→ Track A: 5.1 (session MCP) ──→ 5.3 (batch)
                                      │                                     5.4 (agent reindex)
                                      │                                     5.5 (change-aware)
                                      │    5.2 (graph MCP tools) [after 5.0.1 auth]
                                      │
                                      ├──→ Track B: 5.6 (scale benchmark) [independent]
                                      │    5.7 (prose fix) [independent]
                                      │    5.8 (MRR forensics) [independent]
                                      │    5.9 (cross-repo eval) ──→ 5.10 (xref)
                                      │    5.11 (graph viz) [independent]
                                      │    5.12 (import resolution) ──→ 5.2 (MCP graph tools)
                                      │    5.13 (extractor fixes) [after 5.0.11 eval backfill]
                                      │
                                      └──→ Track C: 5.14 (batch API) [independent]
                                                    5.15 (skeleton utils) ──→ 5.16 (Scala)
                                                    5.17a (RLS Phase 1) ──→ 5.17b (RLS Phase 2)
                                                    5.18 (embed dimensions) [independent]

Cross-track: 5.15 (skeleton utils) ──→ 5.13 (extractor fixes)
```

**Exit criteria**: Agents discover codeindex's cross-repo intelligence via authenticated MCP tools. `xref` and `graph` are the demo features for platform teams. Prose search and MRR regression are fixed. Scale validated at 50K+ files. Full RLS enforces repo isolation on shared PG. Summary costs drop 50% via Batch API. 15 languages with Scala.

---

## Milestone 6: Ecosystem Expansion (Sketch)
*Goal: Broaden language coverage, deepen session intelligence, and mature the platform based on M5 telemetry data.*

| # | Item | Description | Size | Status |
|---|------|-------------|------|--------|
| 6.1 | Zig extractor | Skeleton extraction + test coverage + eval queries for Zig | S-M | Done |
| 6.2 | Elixir extractor | Skeleton extraction + test coverage + eval queries for Elixir | S-M | Done |
| 6.3 | Lightweight re-ranking | Second-pass re-ranking on top-50 results using local signals: import graph proximity, cross-repo edge weight, recency of co-change. No API calls. Deferred from M5 — borderline on 5% nDCG bar, needs M5 eval infrastructure first | M | Partial (implemented but disabled, quality gate not validated) |
| 6.4 | Local embedding quality mitigation | Auto-detect embedding provider. Provider-specific hybrid weights (BM25 vs. semantic ratio). Query expansion for local models. Needs M5 quality data | S | Partial (query expansion done, formal comparison missing) |
| 6.5 | Session-aware query disambiguation | Context-aware rewriting for follow-up queries. Caching ships in M5; rewriting requires eval validation via telemetry data from M5.0.9 | M | Stub (telemetry-gated) |
| 6.6 | Result clustering | Structured concept groupings in cross-repo search results. Requires telemetry showing agent need | M | Stub (telemetry-gated) |
| 6.7 | Fix-executor pattern | Auto-apply fixes based on `check` policy violations. Inspired by audit's fix executor. Requires check usage data | M | Stub (telemetry-gated) |

### Items Deferred Beyond M6

| Item | Reason | Revisit When |
|------|--------|-------------|
| Community language extractors (Dart, Elm, Obj-C) | No demand signal | Someone asks |
| ~~Policy-based extraction rules~~ | Withdrawn — impedance mismatch with procedural extraction | Never in current form. Shared utilities (5.14) is the replacement |
| Cross-language FFI patterns | Premature, no demonstrated demand | Cross-repo eval reveals systematic gap |
| Learned/ML scoring weights | <100 eval queries, not enough data | Eval dataset reaches 500+ queries |

---

## Items Intentionally NOT on the Roadmap

- **Query understanding**: Still cut. Agents classify their own intent.
- **Real-time cost dashboards**: Over-engineering. `status --cost` is sufficient.
- **Per-operation cost caps**: Too complex. Global caps cover the failure mode.
- **Background daemon mode**: MCP server handles the persistent process use case.
- **~~Policy-based extraction rules~~**: Withdrawn after M5 dialogue — impedance mismatch between procedural tree-sitter extraction and declarative config.

## Quality Gates (New for M5)

Every feature touching the retrieval path has a measurable quality bar:

| Feature | Gate | Metric |
|---------|------|--------|
| Prose search fix (5.7) | Prose eval queries | HitRate@5 >= 0.70 |
| MRR forensics (5.8) | Regression analysis | MRR restored to M1 baseline |
| Cross-repo xref (5.10) | Cross-repo eval (5.9) | P@5 >= 0.80 for cross-boundary queries |
| Import resolution (5.12) | Per-language resolution rate | >80% for Go, Ruby, Kotlin/Java |
| Extractor fixes (5.13) | Per-language eval regression | <2% regression on P@5/nDCG/MRR |
| Scala extractor (5.16) | Per-language eval | 5 queries, P@5 baseline established |
| Full RLS Phase 1 (5.17a) | Eval suite with RLS enabled | No result count changes |
| Full RLS Phase 2 (5.17b) | Performance benchmarks | No query regression >5% |
| Re-ranking (6.3) | Eval comparison | >= 5% nDCG@10 improvement or doesn't ship |
| Local embed mitigation (6.4) | Comparison framework | Local P@5 within 5% of OpenAI P@5 |

---

## Post-Implementation Notes

- **Final language count:** 18 (vs. 14 planned through M4). Original 9 + M4 additions (Kotlin, Swift, Ruby, PHP, Lua) + Scala (M5.16) + Zig (M6.1) + Elixir (M6.2).
- **Unplanned features that were built:** `setup` wizard, Anthropic embedding provider, `telemetry` command, structured event logging.
- **Telemetry-gated stubs (6.5, 6.6, 6.7):** These three M6 items are correctly gated behind telemetry thresholds per design principles ("Observe before scaling"). The stubs exist in the codebase but are intentionally not activated until usage data justifies the investment.

---

## Design Principles Applied Throughout

1. **Discovery layer, not context dump** (STEERING #1) — Results are pointers; agents use Read/Grep to get content
2. **SQL is the API** (STEERING #2) — db-harness + unsafe() escape hatch; no abstraction layers
3. **Progressive disclosure** (STEERING #3) — Coarse-to-fine at every surface; opt-in detail flags
4. **Cost sensitivity** (STEERING #6) — Every feature considers token/API cost; local alternatives where possible
5. **Cross-repo is not second-class** (STEERING #5) — Design decisions never break multi-repo; PG is the primary backend
6. **Measure before optimizing** — Eval dataset and ablation before tuning; comparison framework before local embeddings
7. **No quality-affecting feature ships without eval validation** — Any change to scoring, embedding models, skeleton extraction, or result ranking must be validated against the eval dataset before release
8. **Authenticate before expanding** — No new MCP tools without auth (learned from M3.7→M5.0 gap)
9. **Observe before scaling** — Structured logging + telemetry before multi-agent load

## Key Ordering Rationale

### M0-M2 (historical)
- **M0 before M1**: You can't differentiate on a broken foundation. SQLite parity + reliability are 1-2 weeks of small fixes that unblock everything.
- **Eval before hybrid search**: Measure first, optimize second. Prevents stacking unvalidated signals. Ripgrep baseline keeps us honest.
- **Ablation before hybrid search**: Know which existing signals help before adding new ones.
- **Scope filtering before hybrid search (M2.1 vs M2.2)**: Filtering is table-stakes UX; hybrid search needs measurement to prove value.
- **Skill file in M1, full API in M2**: Agents get raw SQL access immediately; typed API ships once it has mature capabilities.
- **Cost caps in M2, not M4**: Cost visibility without controls is a churn risk.

### M3-M4
- **Migrations first (M3.1)**: Both tracks need it. Caching needs a schema change. MCP consumers need schema stability.
- **Caching second (M3.2)**: Reduces cost of every subsequent reindex. "Every day it ships later is money burned."
- **Parallel workstreams over single ordering**: Adoption (Track A) and distribution (Track B) serve different users with independent dependencies. Forcing one to wait for the other delays value.
- **Comparison framework before local embeddings (M3.4 → M3.6)**: "Measure before optimizing" — don't ship a new embedding backend without proof it doesn't regress quality.
- **Import graph in M3, not M4**: Same extractors being touched for M3.3 construct gaps. Reduces total effort. Enables M4.1 cross-repo relationships.
- **Cross-repo relationships split**: Import graph indexing (M3.9) is per-file M-sized foundation. Cross-repo linking (M4.1) builds on it.
- **Access control in M4, not M3**: First M3 adopters aren't sharing PG instances yet.
- **Language coverage split**: Construct gaps (M3.3) before new languages (M4.2). Fix what you have before adding more.

### M5
- **Pre-M5 bug fixes immediately**: Pricing bug causes 4x cost overruns. SSE bug blocks multi-agent. Edge wipe is data loss. All XS — ship before anything else.
- **Foundation before features (M5.0)**: MCP has no auth (security gap), pricing is stale (cost gap), no telemetry (decision gap), DX items rotting in limbo. Every persona independently flagged foundational debt.
- **Quality fixes lead Track B (5.6-5.8)**: 38% MRR regression and broken prose search (HitRate@5=0.286) undermine trust. Fix regressions before building new features on top.
- **Session MCP leads Track A (5.1)**: Query-time embeddings are the dominant remaining cost. Exact-match hash caching (no semantic similarity in v1) gives 30-40% cost reduction + <5ms latency for cached queries. Server-level cache naturally enables multi-agent dedup.
- **Cross-repo eval gates xref (5.9 → 5.10)**: "No quality-affecting feature ships without eval validation." Cross-boundary retrieval quality is unmeasured.
- **Session and batch kept separate (5.1 vs 5.3)**: Batch is stateless (fire N queries at once). Session adds server-side state (refine over time). Different complexity, different use cases.
- **Full RLS in M5, two-phase (5.17a → 5.17b)**: Multi-repo users on shared PG need real isolation — `db.unsafe()` bypasses app-level scoped tokens. Phase 1 covers simple tables with direct `repo_id`. Phase 2 covers join-dependent tables only after Phase 1 passes performance gates.
- **Scala is the only new M5 language**: Demand-driven. One language done well (with eval, tests, import resolution) beats three done partially. Zig and Elixir are firm M6 commitments.
- **Re-ranking deferred to M6**: Borderline on 5% nDCG bar based on rough estimates. Needs M5 eval infrastructure (scale benchmark, cross-repo eval) to validate properly. Still has a kill gate.
- **Query disambiguation deferred to M6**: Caching ships in M5. Rewriting requires telemetry data showing follow-up query patterns.
