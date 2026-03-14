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
// Core xref implementation
// ---------------------------------------------------------------------------

export async function xrefSymbol(repoRoot: string, symbol: string): Promise<XrefResult> {
  const config = await loadConfig(repoRoot);
  const matches: XrefMatch[] = [];

  if (config.store === "pg") {
    await xrefPg(symbol, matches);
  } else {
    await xrefSqlite(repoRoot, symbol, matches);
  }

  // Group by repo
  const byRepo: Record<string, XrefMatch[]> = {};
  for (const m of matches) {
    const key = m.repoName;
    if (!byRepo[key]) byRepo[key] = [];
    byRepo[key].push(m);
  }

  return { symbol, matches, byRepo };
}

// ---------------------------------------------------------------------------
// PostgreSQL xref
// ---------------------------------------------------------------------------

async function xrefPg(symbol: string, matches: XrefMatch[]): Promise<void> {
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

  if (docs.length === 0) return;

  const bm25Index = buildBM25Index(docs);
  const bm25Scores = scoreBM25(bm25Index, symbol);

  // Map file IDs back to rows
  const rowById = new Map<string, (typeof skeletonRows)[0]>();
  for (const row of skeletonRows) {
    rowById.set(String(row.id), row);
  }

  // Top definition matches (files whose skeleton mentions the symbol)
  const definitionFileIds = new Set<string>();
  const sortedEntries = [...bm25Scores.entries()].sort((a, b) => b[1] - a[1]);
  for (const [fileId, score] of sortedEntries.slice(0, 20)) {
    if (score <= 0) continue;
    const row = rowById.get(fileId);
    if (!row) continue;
    definitionFileIds.add(fileId);
    matches.push({
      filePath: String(row.file_path),
      repoName: String(row.repo_name),
      repoId: Number(row.repo_id),
      matchType: "definition",
      score,
    });
  }

  // 2. Follow import graph edges to find consumers
  if (definitionFileIds.size > 0) {
    const fileIdArray = [...definitionFileIds].map(Number);
    const consumers = await pg`
      SELECT DISTINCT fi.source_file_id, f.file_path, f.repo_id, r.name as repo_name
      FROM file_imports fi
      JOIN files f ON fi.source_file_id = f.id
      JOIN repos r ON f.repo_id = r.id
      WHERE fi.resolved_file_id = ANY(${fileIdArray})
    `;

    for (const c of consumers) {
      matches.push({
        filePath: String(c.file_path),
        repoName: String(c.repo_name),
        repoId: Number(c.repo_id),
        matchType: "consumer",
        score: 0.5, // Consumer score is fixed; they reference the definition
      });
    }

    // 3. Check cross_repo_edges for cross-repo consumers
    const crossEdges = await pg`
      SELECT DISTINCT cre.source_file_id, f.file_path, f.repo_id, r.name as repo_name
      FROM cross_repo_edges cre
      JOIN files f ON cre.source_file_id = f.id
      JOIN repos r ON f.repo_id = r.id
      WHERE cre.target_file_id = ANY(${fileIdArray})
    `;

    for (const c of crossEdges) {
      matches.push({
        filePath: String(c.file_path),
        repoName: String(c.repo_name),
        repoId: Number(c.repo_id),
        matchType: "consumer",
        score: 0.4, // Cross-repo consumer score
      });
    }
  }
}

// ---------------------------------------------------------------------------
// SQLite xref
// ---------------------------------------------------------------------------

async function xrefSqlite(repoRoot: string, symbol: string, matches: XrefMatch[]): Promise<void> {
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
  if (docs.length === 0) return;

  const bm25Index = buildBM25Index(docs);
  const bm25Scores = scoreBM25(bm25Index, symbol);

  const rowById = new Map<number, (typeof skeletonRows)[0]>();
  for (const row of skeletonRows) {
    rowById.set(row.id, row);
  }

  // Top definition matches
  const definitionFileIds = new Set<number>();
  const sortedEntries = [...bm25Scores.entries()].sort((a, b) => b[1] - a[1]);
  for (const [fileId, score] of sortedEntries.slice(0, 20)) {
    if (score <= 0) continue;
    const row = rowById.get(Number(fileId));
    if (!row) continue;
    definitionFileIds.add(row.id);
    matches.push({
      filePath: row.file_path,
      repoName: row.repo_name,
      repoId: row.repo_id,
      matchType: "definition",
      score,
    });
  }

  // 2. Follow import graph edges to find consumers
  if (definitionFileIds.size > 0) {
    const placeholders = [...definitionFileIds].map(() => "?").join(",");
    const consumers = db
      .prepare(
        `SELECT DISTINCT fi.source_file_id, f.file_path, f.repo_id, r.name as repo_name
         FROM file_imports fi
         JOIN files f ON fi.source_file_id = f.id
         JOIN repos r ON f.repo_id = r.id
         WHERE fi.resolved_file_id IN (${placeholders})`,
      )
      .all(...definitionFileIds) as Array<{
      source_file_id: number;
      file_path: string;
      repo_id: number;
      repo_name: string;
    }>;

    for (const c of consumers) {
      matches.push({
        filePath: c.file_path,
        repoName: c.repo_name,
        repoId: c.repo_id,
        matchType: "consumer",
        score: 0.5,
      });
    }

    // 3. Check cross_repo_edges
    const crossEdges = db
      .prepare(
        `SELECT DISTINCT cre.source_file_id, f.file_path, f.repo_id, r.name as repo_name
         FROM cross_repo_edges cre
         JOIN files f ON cre.source_file_id = f.id
         JOIN repos r ON f.repo_id = r.id
         WHERE cre.target_file_id IN (${placeholders})`,
      )
      .all(...definitionFileIds) as Array<{
      source_file_id: number;
      file_path: string;
      repo_id: number;
      repo_name: string;
    }>;

    for (const c of crossEdges) {
      matches.push({
        filePath: c.file_path,
        repoName: c.repo_name,
        repoId: c.repo_id,
        matchType: "consumer",
        score: 0.4,
      });
    }
  }
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
