import { pgUnsafe } from "./db/pg";
import { getSqlite } from "./db/sqlite";
import { loadConfig } from "./config";

// ---------------------------------------------------------------------------
// Pricing constants (USD per 1M tokens)
// ---------------------------------------------------------------------------

export const PRICING = {
  "text-embedding-3-small": { input: 0.02 },
  haiku: { input: 0.25, output: 1.25 },
} as const;

// ---------------------------------------------------------------------------
// Module-level repo context
// ---------------------------------------------------------------------------

let currentRepoId: number | null = null;
let currentRepoRoot: string | null = null;

export function setCurrentRepo(repoId: number, repoRoot: string): void {
  currentRepoId = repoId;
  currentRepoRoot = repoRoot;
}

// ---------------------------------------------------------------------------
// Record a cost event
// ---------------------------------------------------------------------------

export async function recordCost(
  operation: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  if (currentRepoId == null || currentRepoRoot == null) return;

  const pricing =
    model in PRICING ? PRICING[model as keyof typeof PRICING] : null;
  let costUsd = 0;
  if (pricing) {
    costUsd = (tokensIn * ("input" in pricing ? pricing.input : 0)) / 1_000_000;
    if ("output" in pricing) {
      costUsd += (tokensOut * pricing.output) / 1_000_000;
    }
  }

  const config = await loadConfig(currentRepoRoot);
  if (config.store === "pg") {
    await pgUnsafe(
      `INSERT INTO cost_events (repo_id, operation, model, tokens_in, tokens_out, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [currentRepoId, operation, model, tokensIn, tokensOut, costUsd],
    );
  } else {
    const db = await getSqlite(currentRepoRoot);
    db.prepare(
      `INSERT INTO cost_events (repo_id, operation, model, tokens_in, tokens_out, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(currentRepoId, operation, model, tokensIn, tokensOut, costUsd);
  }
}

// ---------------------------------------------------------------------------
// Cost summary
// ---------------------------------------------------------------------------

export interface CostSummaryRow {
  operation: string;
  model: string;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  eventCount: number;
}

export async function getCostSummary(repoRoot: string, repoId?: number): Promise<CostSummaryRow[]> {
  const config = await loadConfig(repoRoot);

  if (config.store === "pg") {
    const whereClause = repoId != null ? "WHERE repo_id = $1" : "";
    const params = repoId != null ? [repoId] : [];
    const rows = await pgUnsafe(
      `SELECT operation, model,
              SUM(tokens_in)::bigint AS total_tokens_in,
              SUM(tokens_out)::bigint AS total_tokens_out,
              SUM(cost_usd) AS total_cost_usd,
              COUNT(*)::bigint AS event_count
       FROM cost_events
       ${whereClause}
       GROUP BY operation, model
       ORDER BY total_cost_usd DESC`,
      params,
    );
    return rows.map((r: Record<string, unknown>) => ({
      operation: r.operation as string,
      model: r.model as string,
      totalTokensIn: Number(r.total_tokens_in),
      totalTokensOut: Number(r.total_tokens_out),
      totalCostUsd: Number(r.total_cost_usd),
      eventCount: Number(r.event_count),
    }));
  } else {
    const db = await getSqlite(repoRoot);
    const whereClause = repoId != null ? "WHERE repo_id = ?" : "";
    const params = repoId != null ? [repoId] : [];
    const rows = db
      .prepare(
        `SELECT operation, model,
                SUM(tokens_in) AS total_tokens_in,
                SUM(tokens_out) AS total_tokens_out,
                SUM(cost_usd) AS total_cost_usd,
                COUNT(*) AS event_count
         FROM cost_events
         ${whereClause}
         GROUP BY operation, model
         ORDER BY total_cost_usd DESC`,
      )
      .all(...params) as {
      operation: string;
      model: string;
      total_tokens_in: number;
      total_tokens_out: number;
      total_cost_usd: number;
      event_count: number;
    }[];
    return rows.map((r) => ({
      operation: r.operation,
      model: r.model,
      totalTokensIn: r.total_tokens_in,
      totalTokensOut: r.total_tokens_out,
      totalCostUsd: r.total_cost_usd,
      eventCount: r.event_count,
    }));
  }
}
