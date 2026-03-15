import { loadConfig } from "./config";
import { getPg } from "./db/pg";
import { getSqlite } from "./db/sqlite";
import { buildIndex as buildBM25Index, score as scoreBM25 } from "./search/bm25";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface XrefMatch {
  filePath: string;
  repoName: string;
  repoId: number;
  matchType: "definition" | "consumer";
  score: number;
}

interface XrefResult {
  symbol: string;
  matches: XrefMatch[];
  byRepo: Record<string, XrefMatch[]>;
}

// ---------------------------------------------------------------------------
// Pure helpers — build match arrays without mutation
// ---------------------------------------------------------------------------

/** Convert BM25-scored skeleton rows into definition matches. */
function buildDefinitionMatches(
  bm25Scores: Map<string, number>,
  rowById: Map<string | number, Record<string, unknown>>,
  limit: number,
): { matches: XrefMatch[]; fileIds: Set<string | number> } {
  const sortedEntries = [...bm25Scores.entries()].sort((a, b) => b[1] - a[1]);
  const fileIds = new Set<string | number>();
  const matches = sortedEntries.slice(0, limit).flatMap(([fileId, score]) => {
    if (score <= 0) return [];
    const row = rowById.get(fileId);
    if (!row) return [];
    fileIds.add(fileId);
    return [
      {
        filePath: String(row.file_path),
        repoName: String(row.repo_name),
        repoId: Number(row.repo_id),
        matchType: "definition" as const,
        score,
      },
    ];
  });
  return { matches, fileIds };
}

/** Convert consumer query rows into consumer matches. */
function buildConsumerMatches(rows: Array<Record<string, unknown>>, score: number): XrefMatch[] {
  return rows.map((c) => ({
    filePath: String(c.file_path),
    repoName: String(c.repo_name),
    repoId: Number(c.repo_id),
    matchType: "consumer" as const,
    score,
  }));
}

/** Group matches by repo name. */
function groupByRepo(matches: XrefMatch[]): Record<string, XrefMatch[]> {
  return matches.reduce<Record<string, XrefMatch[]>>((acc, m) => {
    const key = m.repoName;
    return { ...acc, [key]: [...(acc[key] ?? []), m] };
  }, {});
}

// ---------------------------------------------------------------------------
// Core xref implementation
// ---------------------------------------------------------------------------

export async function xrefSymbol(repoRoot: string, symbol: string): Promise<XrefResult> {
  const config = await loadConfig(repoRoot);

  const matches = config.store === "pg" ? await xrefPg(symbol) : await xrefSqlite(repoRoot, symbol);

  const byRepo = groupByRepo(matches);
  return { symbol, matches, byRepo };
}

// ---------------------------------------------------------------------------
// PostgreSQL xref
// ---------------------------------------------------------------------------

async function xrefPg(symbol: string): Promise<XrefMatch[]> {
  const pg = await getPg();

  // 1. Search skeletons for symbol using BM25 (pre-filter to avoid full table scan)
  const skeletonRows = await pg`
    SELECT f.id, f.file_path, f.skeleton, f.repo_id, r.name as repo_name
    FROM files f
    JOIN repos r ON f.repo_id = r.id
    WHERE f.skeleton IS NOT NULL
      AND f.skeleton ILIKE ${"%" + symbol + "%"}
  `;

  const docs = skeletonRows
    .filter((r: Record<string, unknown>) => r.skeleton)
    .map((r: Record<string, unknown>) => ({
      id: String(r.id),
      text: String(r.skeleton),
    }));

  if (docs.length === 0) return [];

  const bm25Index = buildBM25Index(docs);
  const bm25Scores = scoreBM25(bm25Index, symbol);

  const rowById = new Map<string | number, Record<string, unknown>>(
    skeletonRows.map((row: Record<string, unknown>) => [String(row.id), row]),
  );

  const { matches: definitionMatches, fileIds: definitionFileIds } = buildDefinitionMatches(
    bm25Scores,
    rowById,
    20,
  );

  if (definitionFileIds.size === 0) return definitionMatches;

  // 2. Follow import graph edges to find consumers
  const fileIdArray = [...definitionFileIds].map(Number);
  const consumers = await pg`
    SELECT DISTINCT fi.source_file_id, f.file_path, f.repo_id, r.name as repo_name
    FROM file_imports fi
    JOIN files f ON fi.source_file_id = f.id
    JOIN repos r ON f.repo_id = r.id
    WHERE fi.resolved_file_id = ANY(${fileIdArray})
  `;
  const consumerMatches = buildConsumerMatches(consumers, 0.5);

  // 3. Check cross_repo_edges for cross-repo consumers
  const crossEdges = await pg`
    SELECT DISTINCT cre.source_file_id, f.file_path, f.repo_id, r.name as repo_name
    FROM cross_repo_edges cre
    JOIN files f ON cre.source_file_id = f.id
    JOIN repos r ON f.repo_id = r.id
    WHERE cre.target_file_id = ANY(${fileIdArray})
  `;
  const crossEdgeMatches = buildConsumerMatches(crossEdges, 0.4);

  return [...definitionMatches, ...consumerMatches, ...crossEdgeMatches];
}

// ---------------------------------------------------------------------------
// SQLite xref
// ---------------------------------------------------------------------------

async function xrefSqlite(repoRoot: string, symbol: string): Promise<XrefMatch[]> {
  const db = await getSqlite(repoRoot);

  // 1. Search skeletons for symbol using BM25 (pre-filter to avoid full table scan)
  const skeletonRows = db
    .prepare(
      `SELECT f.id, f.file_path, f.skeleton, f.repo_id, r.name as repo_name
       FROM files f
       JOIN repos r ON f.repo_id = r.id
       WHERE f.skeleton IS NOT NULL
         AND f.skeleton LIKE '%' || ? || '%'`,
    )
    .all(symbol) as Array<{
    id: number;
    file_path: string;
    skeleton: string;
    repo_id: number;
    repo_name: string;
  }>;

  const docs = skeletonRows.map((r) => ({ id: String(r.id), text: r.skeleton }));
  if (docs.length === 0) return [];

  const bm25Index = buildBM25Index(docs);
  const bm25Scores = scoreBM25(bm25Index, symbol);

  const rowById = new Map<string | number, Record<string, unknown>>(
    skeletonRows.map((row) => [row.id, row as unknown as Record<string, unknown>]),
  );

  const { matches: definitionMatches, fileIds: definitionFileIds } = buildDefinitionMatches(
    bm25Scores,
    rowById,
    20,
  );

  if (definitionFileIds.size === 0) return definitionMatches;

  // 2. Follow import graph edges to find consumers
  const fileIdArray = [...definitionFileIds].map(Number);
  const placeholders = fileIdArray.map(() => "?").join(",");
  const consumers = db
    .prepare(
      `SELECT DISTINCT fi.source_file_id, f.file_path, f.repo_id, r.name as repo_name
       FROM file_imports fi
       JOIN files f ON fi.source_file_id = f.id
       JOIN repos r ON f.repo_id = r.id
       WHERE fi.resolved_file_id IN (${placeholders})`,
    )
    .all(...fileIdArray) as Array<Record<string, unknown>>;
  const consumerMatches = buildConsumerMatches(consumers, 0.5);

  // 3. Check cross_repo_edges
  const crossEdges = db
    .prepare(
      `SELECT DISTINCT cre.source_file_id, f.file_path, f.repo_id, r.name as repo_name
       FROM cross_repo_edges cre
       JOIN files f ON cre.source_file_id = f.id
       JOIN repos r ON f.repo_id = r.id
       WHERE cre.target_file_id IN (${placeholders})`,
    )
    .all(...fileIdArray) as Array<Record<string, unknown>>;
  const crossEdgeMatches = buildConsumerMatches(crossEdges, 0.4);

  return [...definitionMatches, ...consumerMatches, ...crossEdgeMatches];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatXrefTable(result: XrefResult): string {
  const lines: string[] = [];
  lines.push(`Cross-references for: ${result.symbol}`);
  lines.push(`${"=".repeat(50)}`);

  for (const [repoName, repoMatches] of Object.entries(result.byRepo)) {
    lines.push(`\n[${repoName}]`);
    const defs = repoMatches.filter((m) => m.matchType === "definition");
    const consumers = repoMatches.filter((m) => m.matchType === "consumer");

    if (defs.length > 0) {
      lines.push("  Definitions:");
      for (const d of defs) {
        lines.push(`    ${d.filePath} (score: ${d.score.toFixed(3)})`);
      }
    }
    if (consumers.length > 0) {
      lines.push("  Consumers:");
      for (const c of consumers) {
        lines.push(`    ${c.filePath}`);
      }
    }
  }

  lines.push(
    `\nTotal: ${result.matches.length} references across ${Object.keys(result.byRepo).length} repo(s)`,
  );
  return lines.join("\n");
}

export function formatXrefJson(result: XrefResult): string {
  return JSON.stringify(result, null, 2);
}
