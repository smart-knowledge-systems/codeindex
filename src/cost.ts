import { AsyncLocalStorage } from "node:async_hooks";
import { computeCostUsd, PRICING } from "@easier-idx/embedding/cost";
import type { CostSummaryRow } from "@easier-idx/embedding/cost";
import { pgUnsafe } from "./db/pg";
import { getSqlite } from "./db/sqlite";
import { loadConfig } from "./config";
import { getStoreOps } from "./repo";
import { logEvent } from "./logging";

export { PRICING };
export type { CostSummaryRow };

// ---------------------------------------------------------------------------
// Async-scoped repo context (safe for concurrent workers)
// ---------------------------------------------------------------------------

interface CostContext {
  repoId: number;
  repoRoot: string;
  store?: "pg" | "sqlite";
}

const costStorage = new AsyncLocalStorage<CostContext>();

export function withCostContext<T>(ctx: CostContext, fn: () => T | Promise<T>): T | Promise<T> {
  return costStorage.run(ctx, fn);
}

export function setCurrentRepo(repoId: number, repoRoot: string, store?: "pg" | "sqlite"): void {
  if (costStorage.getStore()) return;
  costStorage.enterWith({ repoId, repoRoot, store });
}

// ---------------------------------------------------------------------------
// Record a cost event (with repo_id — domain-specific)
// ---------------------------------------------------------------------------

export async function recordCost(
  operation: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  const ctx = costStorage.getStore();
  if (!ctx) {
    logEvent({
      event: "cost.record.skipped",
      reason: "no_context",
      operation,
      model,
    });
    return;
  }

  const { repoId, repoRoot } = ctx;
  const costUsd = computeCostUsd(model, tokensIn, tokensOut);

  const { ops } = await getStoreOps(repoRoot);
  await ops.run(
    `INSERT INTO cost_events (repo_id, operation, model, tokens_in, tokens_out, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [repoId, operation, model, tokensIn, tokensOut, costUsd],
  );
}

// ---------------------------------------------------------------------------
// Cost cap check
// ---------------------------------------------------------------------------

async function fetchCostSumPg(repoId?: number): Promise<number> {
  const whereClause = repoId != null ? "AND repo_id = $1" : "";
  const params = repoId != null ? [repoId] : [];
  const rows = await pgUnsafe(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM cost_events
     WHERE created_at >= now() - interval '60 minutes' ${whereClause}`,
    params,
  );
  return Number(rows[0].total);
}

async function fetchCostSumSqlite(repoRoot: string, repoId?: number): Promise<number> {
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

export async function checkCostCap(
  repoRoot: string,
  repoId?: number,
): Promise<{ exceeded: boolean; current: number; limit: number | null }> {
  const config = await loadConfig(repoRoot);
  const limit = config.costCap.maxCostPerReindex;

  const current =
    config.store === "pg"
      ? await fetchCostSumPg(repoId)
      : await fetchCostSumSqlite(repoRoot, repoId);

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
  embeddingModel = "text-embedding-3-small",
): { embeddingCost: number; summaryCost: number; totalCost: number } {
  const embeddingTokens = fileCount * AVG_TOKENS_PER_FILE + commitCount * 50;
  const modelPricing = PRICING[embeddingModel] ?? PRICING["text-embedding-3-small"];
  const embeddingCost = (embeddingTokens * modelPricing.input) / 1_000_000;

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

function normalizeCostRow(r: Record<string, unknown>): CostSummaryRow {
  return {
    operation: r.operation as string,
    model: r.model as string,
    totalTokensIn: Number(r.total_tokens_in),
    totalTokensOut: Number(r.total_tokens_out),
    totalCostUsd: Number(r.total_cost_usd),
    eventCount: Number(r.event_count),
  };
}

const COST_SUMMARY_SQL = `SELECT operation, model,
        SUM(tokens_in) AS total_tokens_in,
        SUM(tokens_out) AS total_tokens_out,
        SUM(cost_usd) AS total_cost_usd,
        COUNT(*) AS event_count
 FROM cost_events`;

export async function getCostSummary(repoRoot: string, repoId?: number): Promise<CostSummaryRow[]> {
  const { ops } = await getStoreOps(repoRoot);
  const whereClause = repoId != null ? "WHERE repo_id = $1" : "";
  const params = repoId != null ? [repoId] : [];
  const rows = await ops.query<Record<string, unknown>>(
    `${COST_SUMMARY_SQL} ${whereClause} GROUP BY operation, model ORDER BY total_cost_usd DESC`,
    params,
  );
  return rows.map(normalizeCostRow);
}
