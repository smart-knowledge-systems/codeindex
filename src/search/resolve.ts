// ---------------------------------------------------------------------------
// Repo resolution and options resolution
// ---------------------------------------------------------------------------

import { loadConfig } from "../config";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import type { SearchOptions, ScoringConfig } from "./types";
import type { PgRepoRow, SqliteRepoRow } from "./types-internal";

export type ResolvedSearchOptions = Required<Omit<SearchOptions, "embeddingCache">>;

/** Pure: apply defaults, then provider overrides, then user overrides. */
export function resolveSearchOptions(
  options: SearchOptions | undefined,
  scoring: ScoringConfig,
): ResolvedSearchOptions {
  return {
    minScore: options?.minScore ?? scoring.minScore,
    topN: options?.topN ?? 0,
    scope: options?.scope ?? "project",
    includeSkeleton: options?.includeSkeleton ?? false,
    includeSummary: options?.includeSummary ?? false,
    includeSnippet: options?.includeSnippet ?? false,
    scoringOverrides: options?.scoringOverrides ?? {},
    lang: options?.lang ?? [],
    dir: options?.dir ?? [],
    since: options?.since ?? "",
    explain: options?.explain ?? false,
  };
}

/** Pure: merge base scoring with provider and user overrides. */
export function resolveScoring(
  base: ScoringConfig,
  providerOverrides: Partial<ScoringConfig>,
  userOverrides: Partial<ScoringConfig>,
): ScoringConfig {
  return { ...base, ...providerOverrides, ...userOverrides };
}

export async function resolveRepoIds(
  repoRoot: string,
  scope: SearchOptions["scope"],
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<{ repoIds: number[]; currentRepoId: number }> {
  if (config.store === "pg") {
    const repos = (await pgUnsafe(
      `SELECT id, root_path, name FROM repos`,
    )) as unknown as PgRepoRow[];

    const currentRepo = repos.find((r) => r.root_path === repoRoot);
    const currentRepoId = currentRepo ? parseInt(currentRepo.id) : -1;

    if (scope === "all") {
      return { repoIds: repos.map((r) => parseInt(r.id)), currentRepoId };
    }
    if (Array.isArray(scope)) {
      const filtered = repos
        .filter((r) => scope.includes(r.name) || scope.includes(r.root_path))
        .map((r) => parseInt(r.id));
      return { repoIds: filtered.length > 0 ? filtered : [currentRepoId], currentRepoId };
    }
    // "project" or undefined
    return { repoIds: currentRepoId !== -1 ? [currentRepoId] : [], currentRepoId };
  } else {
    const db = await getSqlite(repoRoot);
    const repos = db.prepare(`SELECT id, root_path, name FROM repos`).all() as SqliteRepoRow[];

    const currentRepo = repos.find((r) => r.root_path === repoRoot);
    const currentRepoId = currentRepo ? currentRepo.id : -1;

    if (scope === "all") {
      return { repoIds: repos.map((r) => r.id), currentRepoId };
    }
    if (Array.isArray(scope)) {
      const filtered = repos
        .filter((r) => scope.includes(r.name) || scope.includes(r.root_path))
        .map((r) => r.id);
      return { repoIds: filtered.length > 0 ? filtered : [currentRepoId], currentRepoId };
    }
    return { repoIds: currentRepoId !== -1 ? [currentRepoId] : [], currentRepoId };
  }
}
