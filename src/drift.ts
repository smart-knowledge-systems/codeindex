import { readFileSync, writeFileSync, existsSync } from "fs";
import { loadConfig } from "./config";
import { pgUnsafe } from "./db/pg";
import { getSqlite } from "./db/sqlite";
import { cosineSimilarity, deserializeEmbedding } from "./db/util";
import { embedSingle } from "./index/embedder";

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

function parseAgentsMd(content: string): AgentsMdSection[] {
  const sections: AgentsMdSection[] = [];
  const parts = content.split(/^## /m);

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const newlineIdx = part.indexOf("\n");
    if (newlineIdx === -1) continue;

    let header = part.slice(0, newlineIdx).trim();
    // Remove [REVIEW] tag if present
    header = header.replace(/\s*\[REVIEW\]\s*$/, "");
    // Normalize dir path: remove trailing slash, handle "./" as "."
    let dirPath = header;
    if (dirPath === "./" || dirPath === ".") {
      dirPath = ".";
    } else if (dirPath.endsWith("/")) {
      dirPath = dirPath.slice(0, -1);
    }

    // Extract content (summary text, excluding **Files:** line)
    const body = part.slice(newlineIdx + 1).trim();
    const lines = body.split("\n").filter((l) => !l.startsWith("**Files:**"));
    const sectionContent = lines.join("\n").trim();

    sections.push({ dirPath, content: sectionContent });
  }

  return sections;
}

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

  const results: DriftResult[] = [];

  for (const section of sections) {
    if (section.content.length === 0) {
      results.push({ dirPath: section.dirPath, status: "missing" });
      continue;
    }

    const sectionEmbedding = await embedSingle(section.content);
    const dbEmbedding = await getSummaryEmbedding(repoId, section.dirPath, store, repoRoot);

    if (!dbEmbedding) {
      results.push({ dirPath: section.dirPath, status: "missing" });
      continue;
    }

    const similarity = cosineSimilarity(sectionEmbedding, dbEmbedding);
    const drift = 1 - similarity;
    const status: DriftResult["status"] = drift > effectiveThreshold ? "stale" : "fresh";

    results.push({ dirPath: section.dirPath, status, similarity });
  }

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`Wrote drift results to ${outPath}`);
  } else {
    // Print table to stdout
    console.log("");
    for (const r of results) {
      const simStr = r.similarity != null ? r.similarity.toFixed(2) : "-";
      const paddedPath = r.dirPath.padEnd(20);
      const paddedStatus = r.status.padEnd(10);
      console.log(`${paddedPath}${paddedStatus}${simStr}`);
    }
    console.log("");
  }

  return results;
}
