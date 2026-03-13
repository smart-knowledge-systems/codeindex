import { pgUnsafe } from "./db/pg";
import { getSqlite } from "./db/sqlite";
import { loadConfig } from "./config";

// ---------------------------------------------------------------------------
// Pricing constants (USD per 1M tokens)
// ---------------------------------------------------------------------------

export const PRICING: Record<string, { input: number; output?: number }> = {
  "text-embedding-3-small": { input: 0.02 },
  "text-embedding-3-large": { input: 0.13 },
  "nomic-embed-text": { input: 0 }, // local model, no API cost
  haiku: { input: 0.25, output: 1.25 },
};

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

  const pricing = model in PRICING ? PRICING[model as keyof typeof PRICING] : null;
  let costUsd = 0;
  if (pricing) {
    costUsd = (tokensIn * pricing.input) / 1_000_000;
    if (pricing.output != null) {
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
// Cost cap check
// ---------------------------------------------------------------------------

export async function checkCostCap(
  repoRoot: string,
  repoId?: number,
): Promise<{ exceeded: boolean; current: number; limit: number | null }> {
  const config = await loadConfig(repoRoot);
  const limit = config.costCap.maxCostPerReindex;

  // Query total cost for this session (last 60 minutes as session window)
  const current = await (async () => {
    if (config.store === "pg") {
      const whereClause = repoId != null ? "AND repo_id = $1" : "";
      const params = repoId != null ? [repoId] : [];
      const rows = await pgUnsafe(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM cost_events
         WHERE created_at >= now() - interval '60 minutes' ${whereClause}`,
        params,
      );
      return Number(rows[0].total);
    } else {
      const db = await getSqlite(repoRoot);
      const whereClause = repoId != null ? "AND repo_id = ?" : "";
      const params = repoId != null ? [repoId] : [];
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(cost_usd), 0) AS total
           FROM cost_events
           WHERE created_at >= datetime('now', '-60 minutes') ${whereClause}`,
        )
        .get(...params) as { total: number };
      return row.total;
    }
  })();

  return {
    exceeded: limit != null && current >= limit,
    current,
    limit,
  };
}

// ---------------------------------------------------------------------------
// Projected cost estimation
// ---------------------------------------------------------------------------

const AVG_TOKENS_PER_FILE = 500;
const AVG_TOKENS_PER_DIR = 2000;

export function getProjectedCost(
  fileCount: number,
  commitCount: number,
): { embeddingCost: number; summaryCost: number; totalCost: number } {
  const embeddingTokens = fileCount * AVG_TOKENS_PER_FILE + commitCount * 50;
  const embeddingCost = (embeddingTokens * PRICING["text-embedding-3-small"].input) / 1_000_000;

  // Estimate ~1 directory per 5 files, each needing haiku summarization
  const estimatedDirs = Math.max(1, Math.ceil(fileCount / 5));
  const summaryInputTokens = estimatedDirs * AVG_TOKENS_PER_DIR;
  const summaryOutputTokens = estimatedDirs * 200;
  const summaryCost =
    (summaryInputTokens * PRICING.haiku.input) / 1_000_000 +
    (summaryOutputTokens * (PRICING.haiku.output ?? 0)) / 1_000_000;

  return {
    embeddingCost,
    summaryCost,
    totalCost: embeddingCost + summaryCost,
  };
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
