import { AsyncLocalStorage } from "node:async_hooks";
import { pgUnsafe } from "./db/pg";
import { getSqlite } from "./db/sqlite";
import { loadConfig } from "./config";
import { getStoreOps } from "./repo";
import { logEvent } from "./logging";

// ---------------------------------------------------------------------------
// Pricing constants (USD per 1M tokens)
// ---------------------------------------------------------------------------

export const PRICING: Record<string, { input: number; output?: number }> = {
  "text-embedding-3-small": { input: 0.02 },
  "text-embedding-3-large": { input: 0.13 },
  "nomic-embed-text": { input: 0 }, // local model, no API cost
  haiku: { input: 1.0, output: 5.0 },
};

// ---------------------------------------------------------------------------
// Async-scoped repo context (safe for concurrent workers)
// ---------------------------------------------------------------------------

interface CostContext {
  repoId: number;
  repoRoot: string;
  store?: "pg" | "sqlite";
}

const costStorage = new AsyncLocalStorage<CostContext>();

/**
 * Run `fn` with a scoped cost context. All `recordCost` calls within `fn`
 * (including across awaits) will use this context, without racing with
 * other concurrent workers.
 */
export function withCostContext<T>(ctx: CostContext, fn: () => T | Promise<T>): T | Promise<T> {
  return costStorage.run(ctx, fn);
}

/**
 * Set the cost context for the current async execution context.
 * Prefer `withCostContext` for scoped usage; this is kept for callers
 * that set context once at the start of a command.
 */
export function setCurrentRepo(repoId: number, repoRoot: string, store?: "pg" | "sqlite"): void {
  // Skip if already inside a withCostContext scope to avoid overriding scoped context
  if (costStorage.getStore()) return;
  costStorage.enterWith({ repoId, repoRoot, store });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Compute USD cost from token counts and model pricing. */
function computeCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = PRICING[model] ?? null;
  if (!pricing) return 0;
  const inputCost = (tokensIn * pricing.input) / 1_000_000;
  const outputCost = pricing.output != null ? (tokensOut * pricing.output) / 1_000_000 : 0;
  return inputCost + outputCost;
}

/** Normalize a raw cost-summary row (from either pg or sqlite) into a CostSummaryRow. */
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

// ---------------------------------------------------------------------------
// Record a cost event
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
