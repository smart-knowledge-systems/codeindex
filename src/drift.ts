import { readFileSync, writeFileSync, existsSync } from "fs";
import { loadConfig } from "./config";
import { pgUnsafe } from "./db/pg";
import { getSqlite } from "./db/sqlite";
import { cosineSimilarity, deserializeEmbedding } from "./db/util";
import { embed } from "./index/embedder";
import { logEvent } from "./logging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DriftResult {
  dirPath: string;
  status: "fresh" | "stale" | "missing";
  similarity?: number;
}

interface PgRepoRow {
  id: string;
}

interface SqliteRepoRow {
  id: number;
}

interface PgDirEmbeddingRow {
  summary_embedding: string | null;
}

interface SqliteDirEmbeddingRow {
  dir_id: number;
  embedding: Buffer | null;
}

interface AgentsMdSection {
  dirPath: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Parse header text into a normalized directory path. */
function normalizeHeaderPath(raw: string): string {
  const cleaned = raw.replace(/\s*\[REVIEW\]\s*$/, "");
  if (cleaned === "./" || cleaned === ".") return ".";
  return cleaned.endsWith("/") ? cleaned.slice(0, -1) : cleaned;
}

/** Parse an AGENTS.md file into structured sections (pure). */
function parseAgentsMd(content: string): AgentsMdSection[] {
  return content
    .split(/^## /m)
    .slice(1)
    .reduce<AgentsMdSection[]>((acc, part) => {
      const newlineIdx = part.indexOf("\n");
      if (newlineIdx === -1) return acc;

      const dirPath = normalizeHeaderPath(part.slice(0, newlineIdx).trim());
      const body = part.slice(newlineIdx + 1).trim();
      const sectionContent = body
        .split("\n")
        .filter((l) => !l.startsWith("**Files:**"))
        .join("\n")
        .trim();

      return [...acc, { dirPath, content: sectionContent }];
    }, []);
}

/** Build an embedding lookup map from sections (pure transform). */
function buildEmbeddingMap(
  sections: AgentsMdSection[],
  embeddings: number[][],
): Map<string, number[]> {
  return new Map(sections.map((s, i) => [s.dirPath, embeddings[i]]));
}

/** Classify a single section against its stored embedding (pure). */
function classifySection(
  section: AgentsMdSection,
  sectionEmbedding: number[],
  dbEmbedding: number[] | null,
  threshold: number,
): DriftResult {
  if (!dbEmbedding) {
    return { dirPath: section.dirPath, status: "missing" };
  }

  const similarity = cosineSimilarity(sectionEmbedding, dbEmbedding);
  const drift = 1 - similarity;
  const status: DriftResult["status"] = drift > threshold ? "stale" : "fresh";
  return { dirPath: section.dirPath, status, similarity };
}

/** Format drift results as a human-readable table string (pure). */
function formatDriftTable(results: readonly DriftResult[]): string {
  const lines = results.map((r) => {
    const simStr = r.similarity != null ? r.similarity.toFixed(2) : "-";
    return `${r.dirPath.padEnd(20)}${r.status.padEnd(10)}${simStr}`;
  });
  return ["", ...lines, ""].join("\n");
}

// ---------------------------------------------------------------------------
// Data access (impure)
// ---------------------------------------------------------------------------

async function getRepoId(repoRoot: string, store: string): Promise<number> {
  if (store === "pg") {
    const rows = (await pgUnsafe(`SELECT id FROM repos WHERE root_path = $1`, [
      repoRoot,
    ])) as PgRepoRow[];
    if (rows.length === 0) throw new Error(`Repo not found for path: ${repoRoot}`);
    return parseInt(rows[0].id);
  } else {
    const db = await getSqlite(repoRoot);
    const rows = db
      .prepare(`SELECT id FROM repos WHERE root_path = ?`)
      .all(repoRoot) as SqliteRepoRow[];
    if (rows.length === 0) throw new Error(`Repo not found for path: ${repoRoot}`);
    return rows[0].id;
  }
}

async function getSummaryEmbedding(
  repoId: number,
  dirPath: string,
  store: string,
  repoRoot: string,
): Promise<number[] | null> {
  if (store === "pg") {
    const rows = (await pgUnsafe(
      `SELECT summary_embedding FROM directories WHERE repo_id = $1 AND dir_path = $2`,
      [repoId, dirPath],
    )) as PgDirEmbeddingRow[];
    if (rows.length === 0) return null;
    const embStr = rows[0].summary_embedding;
    if (!embStr) return null;
    // PG vector format: "[0.1,0.2,...]"
    return JSON.parse(embStr) as number[];
  } else {
    const db = await getSqlite(repoRoot);
    const dirRows = db
      .prepare(`SELECT id FROM directories WHERE repo_id = ? AND dir_path = ?`)
      .all(repoId, dirPath) as { id: number }[];
    if (dirRows.length === 0) return null;
    const dirId = dirRows[0].id;

    const embRows = db
      .prepare(`SELECT dir_id, embedding FROM dir_summary_embeddings WHERE dir_id = ?`)
      .all(dirId) as SqliteDirEmbeddingRow[];
    if (embRows.length === 0 || !embRows[0].embedding) return null;
    return deserializeEmbedding(Buffer.from(embRows[0].embedding));
  }
}

// ---------------------------------------------------------------------------
// Pure core: compute drift results
// ---------------------------------------------------------------------------

async function computeDriftResults(
  sections: AgentsMdSection[],
  repoId: number,
  store: string,
  repoRoot: string,
  threshold: number,
): Promise<DriftResult[]> {
  // Batch embed all non-empty sections in a single API call
  const sectionsWithContent = sections.filter((s) => s.content.length > 0);
  const sectionEmbeddings =
    sectionsWithContent.length > 0 ? await embed(sectionsWithContent.map((s) => s.content)) : [];
  const embeddingMap = buildEmbeddingMap(sectionsWithContent, sectionEmbeddings);

  const results: DriftResult[] = [];
  for (const section of sections) {
    if (section.content.length === 0) {
      results.push({ dirPath: section.dirPath, status: "missing" });
      continue;
    }

    const sectionEmbedding = embeddingMap.get(section.dirPath)!;
    const dbEmbedding = await getSummaryEmbedding(repoId, section.dirPath, store, repoRoot);
    results.push(classifySection(section, sectionEmbedding, dbEmbedding, threshold));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Impure shell: file I/O and logging
// ---------------------------------------------------------------------------

function outputResults(results: readonly DriftResult[], outPath?: string): void {
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    logEvent({ event: "infra.drift.write", out_path: outPath, result_count: results.length });
  } else {
    process.stdout.write(formatDriftTable(results) + "\n");
  }
}

// ---------------------------------------------------------------------------
// Public API (thin orchestrator)
// ---------------------------------------------------------------------------

export async function detectDrift(
  repoRoot: string,
  agentsMdPath: string,
  threshold?: number,
  outPath?: string,
): Promise<DriftResult[]> {
  if (!existsSync(agentsMdPath)) {
    throw new Error("AGENTS.md not found. Generate it with: codeindex intent --out AGENTS.md");
  }

  const effectiveThreshold = threshold ?? 0.3;
  const config = await loadConfig(repoRoot);
  const store = config.store;
  const repoId = await getRepoId(repoRoot, store);

  const content = readFileSync(agentsMdPath, "utf-8");
  const sections = parseAgentsMd(content);

  const results = await computeDriftResults(sections, repoId, store, repoRoot, effectiveThreshold);

  const staleCount = results.filter((r) => r.status === "stale").length;
  const missingCount = results.filter((r) => r.status === "missing").length;
  logEvent({
    event: "infra.drift.detected",
    repo_root: repoRoot,
    section_count: sections.length,
    stale_count: staleCount,
    missing_count: missingCount,
    threshold: effectiveThreshold,
  });

  outputResults(results, outPath);

  return results;
}
