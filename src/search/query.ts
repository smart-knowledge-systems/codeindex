import path from "path";
import { loadConfig } from "../config";
import { embedSingle } from "../index/embedder";
import { pgUnsafe } from "../db/pg";
import { withRepoScope } from "../db/rls";
import { getSqlite } from "../db/sqlite";
import { serializeEmbedding } from "../db/util";
import type { SearchOptions, SearchResult, ScoringConfig, SkeletonEntry } from "./types";
import { buildIndex as buildBM25Index, score as scoreBM25 } from "./bm25";
import { getScopedRepoIds } from "../auth/tokens";
import { logEvent } from "../logging";
import { recordEvent, hashQuery } from "../telemetry";
import { rerank } from "./rerank";
import { expandQuery } from "./query-expansion";

// ---------------------------------------------------------------------------
// Internal row shapes returned by DB queries
// ---------------------------------------------------------------------------

interface PgFileRow {
  id: string;
  repo_id: string;
  file_path: string;
  skeleton: string | null;
  file_type: string;
  similarity: string;
}

interface PgDirRow {
  id: string;
  repo_id: string;
  dir_path: string;
  summary: string | null;
  concat_sim: string;
  summary_sim: string;
}

interface PgCommitRow {
  id: string;
  repo_id: string;
  commit_hash: string;
  message: string;
  similarity: string;
}

interface PgFileLinkRow {
  file_id: string;
  commit_id: string;
  recency: string;
  similarity: string;
}

interface PgRepoRow {
  id: string;
  root_path: string;
  name: string;
}

interface SqliteFileRow {
  id: number;
  repo_id: number;
  file_path: string;
  skeleton: string | null;
  file_type: string;
  distance: number;
}

interface SqliteDirRow {
  id: number;
  repo_id: number;
  dir_path: string;
  summary: string | null;
  concat_distance: number | null;
  summary_distance: number | null;
}

interface SqliteCommitRow {
  id: number;
  repo_id: number;
  commit_hash: string;
  message: string;
  distance: number;
}

interface SqliteFileLinkRow {
  file_id: number;
  commit_id: number;
  recency: number;
  distance: number;
}

interface SqliteRepoRow {
  id: number;
  root_path: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Scope filtering helpers
// ---------------------------------------------------------------------------

const LANG_ALIASES: Record<string, string[]> = {
  ts: [".ts", ".tsx"],
  typescript: [".ts", ".tsx"],
  js: [".js", ".jsx"],
  javascript: [".js", ".jsx"],
  python: [".py"],
  py: [".py"],
  rust: [".rs"],
  rs: [".rs"],
  go: [".go"],
  java: [".java"],
  c: [".c", ".h"],
  cpp: [".cpp", ".hpp", ".cc", ".cxx", ".hh"],
  "c++": [".cpp", ".hpp", ".cc", ".cxx", ".hh"],
  csharp: [".cs"],
  "c#": [".cs"],
  cs: [".cs"],
  kotlin: [".kt", ".kts"],
  kt: [".kt", ".kts"],
  swift: [".swift"],
  ruby: [".rb"],
  rb: [".rb"],
  php: [".php"],
  lua: [".lua"],
  zig: [".zig"],
  elixir: [".ex", ".exs"],
  ex: [".ex", ".exs"],
};

function resolveLangExtensions(langs: string[]): string[] {
  const exts = new Set<string>();
  for (const lang of langs) {
    const key = lang.toLowerCase();
    const mapped = LANG_ALIASES[key];
    if (mapped) {
      for (const e of mapped) exts.add(e);
    } else {
      // Treat as raw extension: ".foo" or "foo" -> ".foo"
      exts.add(key.startsWith(".") ? key : `.${key}`);
    }
  }
  return [...exts];
}

function parseSince(since: string): Date {
  const match = since.match(/^(\d+)([dwm])$/);
  if (match) {
    const n = parseInt(match[1]);
    const unit = match[2];
    const now = new Date();
    if (unit === "d") now.setDate(now.getDate() - n);
    else if (unit === "w") now.setDate(now.getDate() - n * 7);
    else if (unit === "m") now.setMonth(now.getMonth() - n);
    return now;
  }
  // Try ISO date
  const d = new Date(since);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid --since value: "${since}". Use Nd, Nw, Nm, or ISO date.`);
  }
  return d;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeCommitBoost(
  links: Array<{ recency: number; similarity: number }>,
  scoring: ScoringConfig,
): number {
  const { commitDecay, commitDepth } = scoring;
  let boost = 0;
  for (const link of links) {
    if (link.recency > commitDepth) continue;
    boost += link.similarity * Math.pow(1 - commitDecay, link.recency - 1);
  }
  return boost;
}

/** Prose file types exempt from length normalization penalty. */
const PROSE_FILE_TYPES = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);

/** Map file extension to language profile key. */
const EXT_TO_LANG_KEY: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".cpp": "cpp",
  ".cs": "csharp",
};

/** Resolve per-language scoring overrides for a given file type. */
function langScoring(
  fileType: string,
  base: ScoringConfig,
  profiles?: Record<string, Partial<ScoringConfig>>,
): ScoringConfig {
  if (!profiles) return base;
  const lang = EXT_TO_LANG_KEY[fileType];
  if (!lang) return base;
  const override = profiles[lang];
  if (!override) return base;
  return { ...base, ...override };
}

// ---------------------------------------------------------------------------
// PostgreSQL implementation
// ---------------------------------------------------------------------------

async function searchPg(
  repoIds: number[],
  currentRepoId: number,
  queryEmbedding: number[],
  query: string,
  options: Required<Omit<SearchOptions, "embeddingCache">>,
  scoring: ScoringConfig,
  languageProfiles?: Record<string, Partial<ScoringConfig>>,
): Promise<SearchResult[]> {
  // Use withRepoScope to pin to a single connection, set RLS scope, and
  // apply SET LOCAL hnsw.ef_search within the same transaction
  return withRepoScope(repoIds, async (tx) => {
    return await searchPgInTransaction(
      tx,
      repoIds,
      currentRepoId,
      queryEmbedding,
      query,
      options,
      scoring,
      languageProfiles,
    );
  });
}

async function searchPgInTransaction(
  pg: InstanceType<typeof import("bun").SQL>,
  repoIds: number[],
  currentRepoId: number,
  queryEmbedding: number[],
  query: string,
  options: Required<Omit<SearchOptions, "embeddingCache">>,
  scoring: ScoringConfig,
  languageProfiles?: Record<string, Partial<ScoringConfig>>,
): Promise<SearchResult[]> {
  await pg.unsafe("SET LOCAL hnsw.ef_search = 40");

  // Defense-in-depth: validate interpolated values are strictly numeric
  // to prevent SQL injection even if upstream data is compromised.
  for (const v of queryEmbedding) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`Invalid embedding value: ${String(v)}`);
    }
  }
  for (const id of repoIds) {
    if (typeof id !== "number" || !Number.isInteger(id)) {
      throw new Error(`Invalid repo ID: ${String(id)}`);
    }
  }

  const vecLiteral = `'[${queryEmbedding.join(",")}]'::vector`;
  const repoIdList = repoIds.join(",");

  // Resolve scope filters
  const langExts =
    options.lang && options.lang.length > 0 ? resolveLangExtensions(options.lang) : null;
  const dirFilters = options.dir && options.dir.length > 0 ? options.dir : null;
  const sinceDate = options.since ? parseSince(options.since) : null;

  // --- Repo info map ---
  const repoInfoRows = (await pg.unsafe(
    `SELECT id, root_path, name FROM repos WHERE id IN (${repoIdList})`,
  )) as PgRepoRow[];
  const repoInfoMap = new Map<number, { name: string; rootPath: string }>();
  for (const r of repoInfoRows) {
    repoInfoMap.set(parseInt(r.id), { name: r.name, rootPath: r.root_path });
  }

  // --- Files ---
  let fileFilterSql = "";
  const fileFilterParams: string[] = [];
  let paramIdx = 1;

  if (langExts) {
    fileFilterSql += ` AND file_type IN (${langExts.map(() => `$${paramIdx++}`).join(",")})`;
    fileFilterParams.push(...langExts);
  }
  if (dirFilters) {
    const dirConds = dirFilters.map(() => `file_path LIKE $${paramIdx++}`).join(" OR ");
    fileFilterSql += ` AND (${dirConds})`;
    fileFilterParams.push(...dirFilters.map((d) => `${d.replace(/\/$/, "")}/%`));
  }
  if (sinceDate) {
    fileFilterSql += ` AND id IN (SELECT fc.file_id FROM file_commits fc JOIN commits c ON c.id = fc.commit_id WHERE c.authored_at >= $${paramIdx++})`;
    fileFilterParams.push(sinceDate.toISOString());
  }

  const fileRows = (await pg.unsafe(
    `SELECT id, repo_id, file_path, skeleton, file_type,
            1 - (embedding <=> ${vecLiteral}) AS similarity
     FROM files
     WHERE repo_id IN (${repoIdList}) AND embedding IS NOT NULL${fileFilterSql}`,
    fileFilterParams.length > 0 ? (fileFilterParams as never[]) : undefined,
  )) as PgFileRow[];

  // --- Directories ---
  let dirFilterSql = "";
  const dirFilterParams: unknown[] = [];
  let dirParamIdx = 1;

  if (dirFilters) {
    const dirConds = dirFilters
      .map(() => {
        const p1 = `$${dirParamIdx++}`;
        const p2 = `$${dirParamIdx++}`;
        return `(dir_path LIKE ${p1} OR dir_path = ${p2})`;
      })
      .join(" OR ");
    dirFilterSql += ` AND (${dirConds})`;
    dirFilterParams.push(
      ...dirFilters.flatMap((d) => {
        const clean = d.replace(/\/$/, "");
        return [`${clean}/%`, clean];
      }),
    );
  }

  const dirRows = (await pg.unsafe(
    `SELECT id, repo_id, dir_path, summary,
            1 - (concat_embedding <=> ${vecLiteral}) AS concat_sim,
            CASE WHEN summary_embedding IS NOT NULL
                 THEN 1 - (summary_embedding <=> ${vecLiteral})
                 ELSE 0
            END AS summary_sim
     FROM directories
     WHERE repo_id IN (${repoIdList}) AND concat_embedding IS NOT NULL${dirFilterSql}`,
    dirFilterParams.length > 0 ? (dirFilterParams as never[]) : undefined,
  )) as PgDirRow[];

  // --- Commits ---
  let commitFilterSql = "";
  const commitFilterParams: unknown[] = [];

  if (sinceDate) {
    commitFilterSql += ` AND authored_at >= $1`;
    commitFilterParams.push(sinceDate.toISOString());
  }

  const commitRows = (await pg.unsafe(
    `SELECT id, repo_id, commit_hash, message,
            1 - (embedding <=> ${vecLiteral}) AS similarity
     FROM commits
     WHERE repo_id IN (${repoIdList}) AND embedding IS NOT NULL${commitFilterSql}`,
    commitFilterParams.length > 0 ? (commitFilterParams as never[]) : undefined,
  )) as PgCommitRow[];

  // --- File–commit links for boost (limited to commitDepth) ---
  const linkRows = (await pg.unsafe(
    `SELECT fc.file_id, fc.commit_id, fc.recency,
            1 - (c.embedding <=> ${vecLiteral}) AS similarity
     FROM file_commits fc
     JOIN commits c ON c.id = fc.commit_id
     WHERE fc.file_id IN (
       SELECT id FROM files WHERE repo_id IN (${repoIdList}) AND embedding IS NOT NULL
     )
     AND fc.recency <= $1
     AND c.embedding IS NOT NULL`,
    [scoring.commitDepth] as never[],
  )) as PgFileLinkRow[];

  // Build dir similarity map: dir_path -> similarity
  const dirSimByPath = new Map<string, number>();
  const dirRepoByPath = new Map<string, number>();
  const dirSummaryByPath = new Map<string, string | null>();
  for (const d of dirRows) {
    const concatSim = parseFloat(d.concat_sim);
    const summarySim = parseFloat(d.summary_sim);
    const sim = Math.max(concatSim, summarySim);
    dirSimByPath.set(`${d.repo_id}:${d.dir_path}`, sim);
    dirRepoByPath.set(`${d.repo_id}:${d.dir_path}`, parseInt(d.repo_id));
    dirSummaryByPath.set(`${d.repo_id}:${d.dir_path}`, d.summary);
  }

  // Build commit link map: file_id -> links[]
  const linksByFileId = new Map<number, Array<{ recency: number; similarity: number }>>();
  for (const link of linkRows) {
    const fileId = parseInt(link.file_id);
    const links = linksByFileId.get(fileId) ?? [];
    links.push({ recency: parseInt(link.recency), similarity: parseFloat(link.similarity) });
    linksByFileId.set(fileId, links);
  }

  // Build commit id set by file
  const commitIdsByFileId = new Map<number, string[]>();
  for (const link of linkRows) {
    const fileId = parseInt(link.file_id);
    const ids = commitIdsByFileId.get(fileId) ?? [];
    ids.push(link.commit_id);
    commitIdsByFileId.set(fileId, ids);
  }

  const results: SearchResult[] = [];
  const { minScore, includeSkeleton, includeSummary } = options;
  const { alpha, beta, gamma } = scoring;

  // Collect child file scores per directory for child-to-parent propagation
  const childScoresByDir = new Map<string, number[]>();

  // --- BM25 hybrid scoring ---
  const { hybridWeight, lengthPenaltyWeight } = scoring;
  const bm25Docs = fileRows.filter((r) => r.skeleton).map((r) => ({ id: r.id, text: r.skeleton! }));
  const bm25Index = bm25Docs.length > 0 ? buildBM25Index(bm25Docs) : null;
  const bm25Scores = bm25Index ? scoreBM25(bm25Index, query) : new Map<string, number>();
  const maxBM25 = bm25Scores.size > 0 ? Math.max(...bm25Scores.values()) : 1;

  // Average skeleton token count for length normalization (approximate: chars / 4)
  let totalTokenCount = 0;
  let skeletonCount = 0;
  for (const row of fileRows) {
    if (row.skeleton) {
      totalTokenCount += row.skeleton.length / 4;
      skeletonCount++;
    }
  }
  const avgTokenCount = skeletonCount > 0 ? totalTokenCount / skeletonCount : 1;

  // --- File results ---
  for (const row of fileRows) {
    const fileId = parseInt(row.id);
    const repoId = parseInt(row.repo_id);
    const fileSim = parseFloat(row.similarity);
    const fileScoring = langScoring(row.file_type, scoring, languageProfiles);
    const links = linksByFileId.get(fileId) ?? [];
    const commitBoost = computeCommitBoost(links, fileScoring);

    const parentDir = path.dirname(row.file_path);
    const dirKey = `${row.repo_id}:${parentDir}`;
    const dirSim = dirSimByPath.get(dirKey) ?? 0;
    const parentBoost = dirSim > minScore ? fileScoring.parentBoostMultiplier * dirSim : 0;

    // Length normalization penalty (token-approximated skeleton length)
    // Prose files (md, rst, txt, adoc) are exempt — their skeletons are intentionally
    // full-content and should not be penalized for length.
    const tokenCount = (row.skeleton?.length ?? 0) / 4;
    const isProse = PROSE_FILE_TYPES.has(row.file_type);
    const lengthPenalty =
      !isProse && tokenCount > 0
        ? Math.max(0, Math.log(tokenCount / avgTokenCount)) * lengthPenaltyWeight
        : 0;

    // Semantic score with length penalty (using per-language alpha/beta)
    const fAlpha = fileScoring.alpha;
    const fBeta = fileScoring.beta;
    const semanticScore = fileSim + fAlpha * commitBoost + fBeta * parentBoost - lengthPenalty;

    // BM25 keyword score
    const rawBM25 = bm25Scores.get(row.id) ?? 0;
    const normalizedBM25 = maxBM25 > 0 ? rawBM25 / maxBM25 : 0;

    // Hybrid fusion
    const finalScore =
      hybridWeight > 0
        ? (1 - hybridWeight) * semanticScore + hybridWeight * normalizedBM25
        : semanticScore;

    if (finalScore >= minScore) {
      const scores = childScoresByDir.get(dirKey) ?? [];
      scores.push(finalScore);
      childScoresByDir.set(dirKey, scores);
    }
    if (finalScore < minScore) continue;

    const repoInfo = repoInfoMap.get(repoId);
    const result: SearchResult = {
      filePath: row.file_path,
      cosineSimilarity: fileSim,
      finalScore,
      type: row.file_type,
      inProject: repoId === currentRepoId,
      repoName: repoInfo?.name,
      repoPath: repoInfo?.rootPath,
    };
    if (normalizedBM25 > 0) result.keywordScore = normalizedBM25;
    if (repoId !== currentRepoId) result.repoId = row.repo_id;
    if (includeSkeleton && row.skeleton) result.skeleton = row.skeleton;
    const commitIds = commitIdsByFileId.get(fileId);
    if (commitIds && commitIds.length > 0) result.commitIds = commitIds;
    if (options.explain) {
      result.explanation = {
        cosineSimilarity: fileSim,
        commitBoost,
        parentBoost,
        keywordScore: normalizedBM25,
        lengthPenalty,
        weights: { alpha, beta, gamma },
        formula: `(1-${hybridWeight})*[${fileSim.toFixed(3)} + ${alpha}*${commitBoost.toFixed(3)} + ${beta}*${parentBoost.toFixed(3)} - ${lengthPenalty.toFixed(3)}] + ${hybridWeight}*${normalizedBM25.toFixed(3)} = ${finalScore.toFixed(3)}`,
      };
    }
    results.push(result);
  }

  // --- Directory results ---
  for (const row of dirRows) {
    const repoId = parseInt(row.repo_id);
    const concatSim = parseFloat(row.concat_sim);
    const summarySim = parseFloat(row.summary_sim);
    let finalScore = Math.max(concatSim, summarySim);

    // Child-to-parent boost: if >= 2 child files scored above minScore,
    // boost directory by gamma * AVG(top child scores)
    const dirKey = `${row.repo_id}:${row.dir_path}`;
    const childScores = childScoresByDir.get(dirKey) ?? [];
    if (childScores.length >= 2) {
      const avg = childScores.reduce((a, b) => a + b, 0) / childScores.length;
      finalScore += gamma * avg;
    }

    if (finalScore < minScore) continue;

    const repoInfo = repoInfoMap.get(repoId);
    const result: SearchResult = {
      filePath: row.dir_path,
      cosineSimilarity: Math.max(concatSim, summarySim),
      finalScore,
      type: "dir",
      inProject: repoId === currentRepoId,
      repoName: repoInfo?.name,
      repoPath: repoInfo?.rootPath,
    };
    if (repoId !== currentRepoId) result.repoId = row.repo_id;
    if (includeSummary && row.summary) result.summary = row.summary;
    if (options.explain) {
      const baseSim = Math.max(concatSim, summarySim);
      const childBoost = finalScore - baseSim;
      result.explanation = {
        cosineSimilarity: baseSim,
        commitBoost: 0,
        parentBoost: 0,
        childBoost,
        weights: { alpha, beta, gamma },
        formula: `${baseSim.toFixed(3)} + γ*childAvg = ${finalScore.toFixed(3)}`,
      };
    }
    results.push(result);
  }

  // --- Commit results ---
  for (const row of commitRows) {
    const repoId = parseInt(row.repo_id);
    const similarity = parseFloat(row.similarity);
    if (similarity < minScore) continue;

    const repoInfo = repoInfoMap.get(repoId);
    const result: SearchResult = {
      filePath: row.commit_hash,
      cosineSimilarity: similarity,
      finalScore: similarity,
      type: "commit",
      inProject: repoId === currentRepoId,
      repoName: repoInfo?.name,
      repoPath: repoInfo?.rootPath,
    };
    if (repoId !== currentRepoId) result.repoId = row.repo_id;
    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

async function searchSqlite(
  repoIds: number[],
  currentRepoId: number,
  repoRoot: string,
  queryEmbedding: number[],
  query: string,
  options: Required<Omit<SearchOptions, "embeddingCache">>,
  scoring: ScoringConfig,
  languageProfiles?: Record<string, Partial<ScoringConfig>>,
): Promise<SearchResult[]> {
  const db = await getSqlite(repoRoot);
  const embBuf = serializeEmbedding(queryEmbedding);
  const repoIdList = repoIds.join(",");
  // Resolve scope filters
  const langExts =
    options.lang && options.lang.length > 0 ? resolveLangExtensions(options.lang) : null;
  const dirFilters = options.dir && options.dir.length > 0 ? options.dir : null;
  const sinceDate = options.since ? parseSince(options.since) : null;

  // Increase KNN over-fetch when scope filters are active to avoid under-returning
  const hasFilters = !!(langExts || dirFilters || sinceDate);
  const knnLimit = Math.max((options.topN || 50) * (hasFilters ? 10 : 3), hasFilters ? 500 : 200);

  // --- Repo info map ---
  const repoInfoRows = db
    .prepare(`SELECT id, root_path, name FROM repos WHERE id IN (${repoIdList})`)
    .all() as SqliteRepoRow[];
  const repoInfoMap = new Map<number, { name: string; rootPath: string }>();
  for (const r of repoInfoRows) {
    repoInfoMap.set(r.id, { name: r.name, rootPath: r.root_path });
  }

  // --- Files (KNN via vec0 MATCH) ---
  // KNN queries in sqlite-vec don't support arbitrary WHERE; post-filter instead
  let fileFilterSql = "";
  const fileFilterParams: string[] = [];
  if (langExts) {
    fileFilterSql += ` AND f.file_type IN (${langExts.map(() => "?").join(",")})`;
    fileFilterParams.push(...langExts);
  }
  if (dirFilters) {
    const dirConds = dirFilters.map(() => "f.file_path LIKE ?").join(" OR ");
    fileFilterSql += ` AND (${dirConds})`;
    fileFilterParams.push(...dirFilters.map((d) => `${d.replace(/\/$/, "")}/%`));
  }
  if (sinceDate) {
    fileFilterSql += ` AND f.id IN (SELECT fc.file_id FROM file_commits fc JOIN commits c ON c.id = fc.commit_id WHERE c.authored_at >= ?)`;
    fileFilterParams.push(sinceDate.toISOString());
  }

  const fileRows = db
    .prepare(
      `SELECT f.id, f.repo_id, f.file_path, f.skeleton, f.file_type,
              fe.distance
       FROM file_embeddings fe
       JOIN files f ON f.id = fe.file_id
       WHERE fe.embedding MATCH ? AND fe.k = ?
         AND f.repo_id IN (${repoIdList})${fileFilterSql}`,
    )
    .all(embBuf, knnLimit, ...fileFilterParams) as SqliteFileRow[];

  // --- Directories (KNN via vec0 MATCH for concat, then point lookup for summary) ---
  let dirFilterSql = "";
  const dirFilterParams: string[] = [];
  if (dirFilters) {
    const dirConds = dirFilters.map(() => "(d.dir_path LIKE ? OR d.dir_path = ?)").join(" OR ");
    dirFilterSql += ` AND (${dirConds})`;
    dirFilterParams.push(
      ...dirFilters.flatMap((d) => {
        const clean = d.replace(/\/$/, "");
        return [`${clean}/%`, clean];
      }),
    );
  }

  const dirConcatRows = db
    .prepare(
      `SELECT d.id, d.repo_id, d.dir_path, d.summary,
              dce.distance AS concat_distance
       FROM dir_concat_embeddings dce
       JOIN directories d ON d.id = dce.dir_id
       WHERE dce.embedding MATCH ? AND dce.k = ?
         AND d.repo_id IN (${repoIdList})${dirFilterSql}`,
    )
    .all(embBuf, knnLimit, ...dirFilterParams) as (SqliteDirRow & { concat_distance: number })[];

  // Batch load summary distances for all directories in a single query
  const summaryByDirId = new Map<number, number>();
  if (dirConcatRows.length > 0) {
    const dirIds = dirConcatRows.map((r) => r.id);
    const dirPlaceholders = dirIds.map(() => "?").join(",");
    try {
      const summaryRows = db
        .prepare(
          `SELECT dir_id, vec_distance_cosine(embedding, ?) AS distance
           FROM dir_summary_embeddings WHERE dir_id IN (${dirPlaceholders})`,
        )
        .all(embBuf, ...dirIds) as { dir_id: number; distance: number }[];
      for (const row of summaryRows) {
        summaryByDirId.set(row.dir_id, row.distance);
      }
    } catch {
      // No summary embeddings table or empty
    }
  }
  const dirRows: SqliteDirRow[] = dirConcatRows.map((row) => ({
    ...row,
    summary_distance: summaryByDirId.get(row.id) ?? null,
  }));

  // --- Commits (KNN via vec0 MATCH) ---
  let commitFilterSql = "";
  const commitFilterParams: string[] = [];
  if (sinceDate) {
    commitFilterSql += ` AND c.authored_at >= ?`;
    commitFilterParams.push(sinceDate.toISOString());
  }

  const commitRows = db
    .prepare(
      `SELECT c.id, c.repo_id, c.commit_hash, c.message,
              ce.distance
       FROM commit_embeddings ce
       JOIN commits c ON c.id = ce.commit_id
       WHERE ce.embedding MATCH ? AND ce.k = ?
         AND c.repo_id IN (${repoIdList})${commitFilterSql}`,
    )
    .all(embBuf, knnLimit, ...commitFilterParams) as SqliteCommitRow[];

  // --- File–commit links (point-to-point distance, not KNN) ---
  const linkRows = db
    .prepare(
      `SELECT fc.file_id, fc.commit_id, fc.recency,
              vec_distance_cosine(ce.embedding, ?) AS distance
       FROM file_commits fc
       JOIN commit_embeddings ce ON ce.commit_id = fc.commit_id
       JOIN files f ON f.id = fc.file_id
       WHERE f.repo_id IN (${repoIdList})
         AND fc.recency <= ?`,
    )
    .all(embBuf, scoring.commitDepth) as SqliteFileLinkRow[];

  // Build dir similarity map
  const dirSimByPath = new Map<string, number>();
  const dirSummaryByPath = new Map<string, string | null>();
  for (const d of dirRows) {
    const concatSim = d.concat_distance != null ? 1 - d.concat_distance : 0;
    const summarySim = d.summary_distance != null ? 1 - d.summary_distance : 0;
    const sim = Math.max(concatSim, summarySim);
    dirSimByPath.set(`${d.repo_id}:${d.dir_path}`, sim);
    dirSummaryByPath.set(`${d.repo_id}:${d.dir_path}`, d.summary);
  }

  // Build commit link map
  const linksByFileId = new Map<number, Array<{ recency: number; similarity: number }>>();
  const commitIdsByFileId = new Map<number, string[]>();
  for (const link of linkRows) {
    const links = linksByFileId.get(link.file_id) ?? [];
    links.push({ recency: link.recency, similarity: 1 - link.distance });
    linksByFileId.set(link.file_id, links);

    const ids = commitIdsByFileId.get(link.file_id) ?? [];
    ids.push(String(link.commit_id));
    commitIdsByFileId.set(link.file_id, ids);
  }

  const results: SearchResult[] = [];
  const { minScore, includeSkeleton, includeSummary } = options;
  const { alpha, beta, gamma } = scoring;

  // Collect child file scores per directory for child-to-parent propagation
  const childScoresByDir = new Map<string, number[]>();

  // --- BM25 hybrid scoring ---
  const { hybridWeight, lengthPenaltyWeight } = scoring;
  const bm25DocsSqlite = fileRows
    .filter((r) => r.skeleton)
    .map((r) => ({ id: String(r.id), text: r.skeleton! }));
  const bm25IndexSqlite = bm25DocsSqlite.length > 0 ? buildBM25Index(bm25DocsSqlite) : null;
  const bm25ScoresSqlite = bm25IndexSqlite
    ? scoreBM25(bm25IndexSqlite, query)
    : new Map<string, number>();
  const maxBM25Sqlite = bm25ScoresSqlite.size > 0 ? Math.max(...bm25ScoresSqlite.values()) : 1;

  // Average skeleton token count for length normalization (approximate: chars / 4)
  let totalTokenCountSqlite = 0;
  let skeletonCountSqlite = 0;
  for (const row of fileRows) {
    if (row.skeleton) {
      totalTokenCountSqlite += row.skeleton.length / 4;
      skeletonCountSqlite++;
    }
  }
  const avgTokenCountSqlite =
    skeletonCountSqlite > 0 ? totalTokenCountSqlite / skeletonCountSqlite : 1;

  // --- File results ---
  for (const row of fileRows) {
    const fileSim = 1 - row.distance;
    const fileScoring = langScoring(row.file_type, scoring, languageProfiles);
    const links = linksByFileId.get(row.id) ?? [];
    const commitBoost = computeCommitBoost(links, fileScoring);

    const parentDir = path.dirname(row.file_path);
    const dirKey = `${row.repo_id}:${parentDir}`;
    const dirSim = dirSimByPath.get(dirKey) ?? 0;
    const parentBoost = dirSim > minScore ? fileScoring.parentBoostMultiplier * dirSim : 0;

    // Length normalization penalty (token-approximated skeleton length)
    // Prose files (md, rst, txt, adoc) are exempt — their skeletons are intentionally
    // full-content and should not be penalized for length.
    const tokenCount = (row.skeleton?.length ?? 0) / 4;
    const isProse = PROSE_FILE_TYPES.has(row.file_type);
    const lengthPenalty =
      !isProse && tokenCount > 0
        ? Math.max(0, Math.log(tokenCount / avgTokenCountSqlite)) * lengthPenaltyWeight
        : 0;

    // Semantic score with length penalty (using per-language alpha/beta)
    const fAlpha = fileScoring.alpha;
    const fBeta = fileScoring.beta;
    const semanticScore = fileSim + fAlpha * commitBoost + fBeta * parentBoost - lengthPenalty;

    // BM25 keyword score
    const rawBM25 = bm25ScoresSqlite.get(String(row.id)) ?? 0;
    const normalizedBM25 = maxBM25Sqlite > 0 ? rawBM25 / maxBM25Sqlite : 0;

    // Hybrid fusion
    const finalScore =
      hybridWeight > 0
        ? (1 - hybridWeight) * semanticScore + hybridWeight * normalizedBM25
        : semanticScore;

    if (finalScore >= minScore) {
      const scores = childScoresByDir.get(dirKey) ?? [];
      scores.push(finalScore);
      childScoresByDir.set(dirKey, scores);
    }
    if (finalScore < minScore) continue;

    const repoInfo = repoInfoMap.get(row.repo_id);
    const result: SearchResult = {
      filePath: row.file_path,
      cosineSimilarity: fileSim,
      finalScore,
      type: row.file_type,
      inProject: row.repo_id === currentRepoId,
      repoName: repoInfo?.name,
      repoPath: repoInfo?.rootPath,
    };
    if (normalizedBM25 > 0) result.keywordScore = normalizedBM25;
    if (row.repo_id !== currentRepoId) result.repoId = String(row.repo_id);
    if (includeSkeleton && row.skeleton) result.skeleton = row.skeleton;
    const commitIds = commitIdsByFileId.get(row.id);
    if (commitIds && commitIds.length > 0) result.commitIds = commitIds;
    if (options.explain) {
      result.explanation = {
        cosineSimilarity: fileSim,
        commitBoost,
        parentBoost,
        keywordScore: normalizedBM25,
        lengthPenalty,
        weights: { alpha, beta, gamma },
        formula: `(1-${hybridWeight})*[${fileSim.toFixed(3)} + ${alpha}*${commitBoost.toFixed(3)} + ${beta}*${parentBoost.toFixed(3)} - ${lengthPenalty.toFixed(3)}] + ${hybridWeight}*${normalizedBM25.toFixed(3)} = ${finalScore.toFixed(3)}`,
      };
    }
    results.push(result);
  }

  // --- Directory results ---
  for (const row of dirRows) {
    const concatSim = row.concat_distance != null ? 1 - row.concat_distance : 0;
    const summarySim = row.summary_distance != null ? 1 - row.summary_distance : 0;
    let finalScore = Math.max(concatSim, summarySim);

    // Child-to-parent boost: if >= 2 child files scored above minScore,
    // boost directory by gamma * AVG(top child scores)
    const dirKey = `${row.repo_id}:${row.dir_path}`;
    const childScores = childScoresByDir.get(dirKey) ?? [];
    if (childScores.length >= 2) {
      const avg = childScores.reduce((a, b) => a + b, 0) / childScores.length;
      finalScore += gamma * avg;
    }

    if (finalScore < minScore) continue;

    const repoInfo = repoInfoMap.get(row.repo_id);
    const result: SearchResult = {
      filePath: row.dir_path,
      cosineSimilarity: Math.max(concatSim, summarySim),
      finalScore,
      type: "dir",
      inProject: row.repo_id === currentRepoId,
      repoName: repoInfo?.name,
      repoPath: repoInfo?.rootPath,
    };
    if (row.repo_id !== currentRepoId) result.repoId = String(row.repo_id);
    if (includeSummary && row.summary) result.summary = row.summary;
    if (options.explain) {
      const baseSim = Math.max(concatSim, summarySim);
      const childBoost = finalScore - baseSim;
      result.explanation = {
        cosineSimilarity: baseSim,
        commitBoost: 0,
        parentBoost: 0,
        childBoost,
        weights: { alpha, beta, gamma },
        formula: `${baseSim.toFixed(3)} + γ*childAvg = ${finalScore.toFixed(3)}`,
      };
    }
    results.push(result);
  }

  // --- Commit results ---
  for (const row of commitRows) {
    const similarity = 1 - row.distance;
    if (similarity < minScore) continue;

    const repoInfo = repoInfoMap.get(row.repo_id);
    const result: SearchResult = {
      filePath: row.commit_hash,
      cosineSimilarity: similarity,
      finalScore: similarity,
      type: "commit",
      inProject: row.repo_id === currentRepoId,
      repoName: repoInfo?.name,
      repoPath: repoInfo?.rootPath,
    };
    if (row.repo_id !== currentRepoId) result.repoId = String(row.repo_id);
    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Repo resolution
// ---------------------------------------------------------------------------

async function resolveRepoIds(
  repoRoot: string,
  scope: SearchOptions["scope"],
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<{ repoIds: number[]; currentRepoId: number }> {
  if (config.store === "pg") {
    const repos = (await pgUnsafe(`SELECT id, root_path, name FROM repos`)) as PgRepoRow[];

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Main semantic search function. Searches files, directories, and commits
 * using cosine similarity of embeddings, applying the commit-boost and
 * parent-directory-boost scoring formula from the spec.
 */
export async function search(
  repoRoot: string,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const config = await loadConfig(repoRoot);

  // Apply provider-specific scoring overrides for non-openai providers
  const provider = config.embedding.provider;
  const providerOverrides = config.providerProfiles?.[provider] ?? {};
  const scoring: ScoringConfig = {
    ...config.scoring,
    ...providerOverrides,
    ...(options?.scoringOverrides ?? {}),
  };

  const resolvedOptions: Required<Omit<SearchOptions, "embeddingCache">> = {
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

  // Expand query for local embedding providers to improve match quality
  const effectiveQuery = provider === "ollama" ? expandQuery(query) : query;

  let queryEmbedding: number[];
  const cached = options?.embeddingCache?.get(effectiveQuery);
  if (cached) {
    queryEmbedding = cached;
  } else {
    queryEmbedding = await embedSingle(effectiveQuery);
    options?.embeddingCache?.set(effectiveQuery, queryEmbedding);
  }
  const resolved = await resolveRepoIds(repoRoot, resolvedOptions.scope, config);
  let repoIds = resolved.repoIds;
  const currentRepoId = resolved.currentRepoId;

  // Apply token-based repo scoping if CODEINDEX_TOKEN is set
  const tokenRepoIds = await getScopedRepoIds(repoRoot);
  if (tokenRepoIds !== null) {
    const allowed = new Set(tokenRepoIds);
    repoIds = repoIds.filter((id) => allowed.has(id));
  }

  if (repoIds.length === 0) {
    return [];
  }

  let results: SearchResult[];

  if (config.store === "pg") {
    results = await searchPg(
      repoIds,
      currentRepoId,
      queryEmbedding,
      query,
      resolvedOptions,
      scoring,
      config.languageProfiles,
    );
  } else {
    results = await searchSqlite(
      repoIds,
      currentRepoId,
      repoRoot,
      queryEmbedding,
      query,
      resolvedOptions,
      scoring,
      config.languageProfiles,
    );
  }

  results.sort((a, b) => b.finalScore - a.finalScore);

  // Apply lightweight re-ranking if enabled
  if (config.reranking?.enabled) {
    const rerankCandidates = results.slice(0, 50);
    const reranked = await rerank(rerankCandidates, {
      store: config.store,
      repoRoot,
      repoIds,
      reranking: config.reranking,
    });
    results = [...reranked, ...results.slice(50)];
    results.sort((a, b) => b.finalScore - a.finalScore);
  }

  const finalResults = resolvedOptions.topN > 0 ? results.slice(0, resolvedOptions.topN) : results;

  // Post-processing: attach snippets if requested
  if (resolvedOptions.includeSnippet) {
    await attachSnippets(repoRoot, config, finalResults, query, currentRepoId);
  }

  // Post-processing: annotate with cross-repo edges if multi-repo
  if (repoIds.length > 1) {
    await attachCrossRepoEdges(repoRoot, config, finalResults, currentRepoId, tokenRepoIds);
  }

  logEvent({ event: "search", query_length: query.length, result_count: finalResults.length });

  recordEvent({
    event: "search",
    timestamp: new Date().toISOString(),
    queryHash: hashQuery(query),
    resultCount: finalResults.length,
  });

  return finalResults;
}

// ---------------------------------------------------------------------------
// Snippet post-processing
// ---------------------------------------------------------------------------

async function attachSnippets(
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  results: SearchResult[],
  query: string,
  currentRepoId: number,
): Promise<void> {
  const queryWords = new Set(
    query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

  // Batch load skeleton_entries for all file results in a single query
  // Include all repo IDs from results (not just current repo) for multi-repo support
  const fileResults = results.filter((r) => r.type !== "dir" && r.type !== "commit");
  const filePaths = fileResults.map((r) => r.filePath);
  const resultRepoIds = [
    ...new Set(
      fileResults
        .map((r) => (r.repoId ? parseInt(r.repoId) : currentRepoId))
        .filter((id) => !isNaN(id)),
    ),
  ];
  // Key by repo_id:file_path to avoid collisions across repos with identical relative paths
  const entriesMap = new Map<string, string>();

  if (filePaths.length > 0) {
    if (config.store === "pg") {
      const rows = await withRepoScope(resultRepoIds, async (tx) => {
        return (await tx.unsafe(
          `SELECT repo_id, file_path, skeleton_entries FROM files
           WHERE repo_id = ANY($1)
           AND file_path = ANY($2)`,
          [resultRepoIds, filePaths],
        )) as { repo_id: string; file_path: string; skeleton_entries: string | null }[];
      });
      for (const row of rows) {
        if (row.skeleton_entries)
          entriesMap.set(`${row.repo_id}:${row.file_path}`, row.skeleton_entries);
      }
    } else {
      const db = await getSqlite(repoRoot);
      const pathPlaceholders = filePaths.map(() => "?").join(",");
      const repoPlaceholders = resultRepoIds.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT f.repo_id, f.file_path, f.skeleton_entries FROM files f
           WHERE f.repo_id IN (${repoPlaceholders}) AND f.file_path IN (${pathPlaceholders})`,
        )
        .all(...resultRepoIds, ...filePaths) as {
        repo_id: number;
        file_path: string;
        skeleton_entries: string | null;
      }[];
      for (const row of rows) {
        if (row.skeleton_entries)
          entriesMap.set(`${row.repo_id}:${row.file_path}`, row.skeleton_entries);
      }
    }
  }

  for (const result of fileResults) {
    const repoId = result.repoId ? parseInt(result.repoId) : currentRepoId;
    const entriesJson = entriesMap.get(`${repoId}:${result.filePath}`);
    if (!entriesJson) continue;

    let entries: SkeletonEntry[];
    try {
      entries = JSON.parse(entriesJson);
    } catch {
      continue;
    }
    if (!entries || entries.length === 0) continue;

    // Find best-matching entry via word-intersection score
    let bestEntry: SkeletonEntry | null = null;
    let bestScore = -1;
    for (const entry of entries) {
      const nameWords = entry.name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2);
      const kindWords = entry.kind
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2);
      const allWords = [...nameWords, ...kindWords];
      let score = 0;
      for (const w of allWords) {
        if (queryWords.has(w)) score++;
        // Partial match bonus
        for (const qw of queryWords) {
          if (w.includes(qw) || qw.includes(w)) score += 0.5;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    // Fallback to first entry if no match
    if (!bestEntry) bestEntry = entries[0];

    result.lineStart = bestEntry.startLine;
    result.lineEnd = bestEntry.endLine;

    // Read source file and extract lines (cap at 20)
    try {
      const absPath = `${repoRoot}/${result.filePath}`;
      const content = await Bun.file(absPath).text();
      const lines = content.split("\n");
      const start = bestEntry.startLine - 1; // 0-indexed
      const maxLines = 20;
      const end = Math.min(bestEntry.endLine, start + maxLines);
      result.snippet = lines.slice(start, end).join("\n");
    } catch {
      // File might not exist on disk
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-repo edge post-processing
// ---------------------------------------------------------------------------

async function attachCrossRepoEdges(
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  results: SearchResult[],
  currentRepoId: number,
  scopedRepoIds: number[] | null = null,
): Promise<void> {
  // Build repo name map
  const repoNameMap = new Map<number, string>();
  if (config.store === "pg") {
    const repos = (await pgUnsafe("SELECT id, name FROM repos")) as {
      id: string;
      name: string;
    }[];
    for (const r of repos) repoNameMap.set(parseInt(r.id), r.name);

    // Build cross-repo edges lookup, filtered by scoped repo IDs if present
    // Wrap in withRepoScope so FORCE RLS on cross_repo_edges passes
    const edgeRepoIds = scopedRepoIds ?? [...repoNameMap.keys()];
    let edgeQuery = `SELECT DISTINCT source_repo_id, target_repo_id FROM cross_repo_edges`;
    const edgeParams: unknown[] = [];
    if (scopedRepoIds !== null && scopedRepoIds.length > 0) {
      const placeholders = scopedRepoIds.map((_, i) => `$${i + 1}`).join(",");
      const placeholders2 = scopedRepoIds
        .map((_, i) => `$${i + 1 + scopedRepoIds.length}`)
        .join(",");
      edgeQuery += ` WHERE (source_repo_id IN (${placeholders}) OR target_repo_id IN (${placeholders2}))`;
      edgeParams.push(...scopedRepoIds, ...scopedRepoIds);
    }
    const allEdges = await withRepoScope(edgeRepoIds, async (tx) => {
      return (await tx.unsafe(edgeQuery, edgeParams)) as {
        source_repo_id: string;
        target_repo_id: string;
      }[];
    });

    const depsByRepo = new Map<
      number,
      Array<{ repoName: string; direction: "depends-on" | "depended-by" }>
    >();
    for (const e of allEdges) {
      const srcId = parseInt(e.source_repo_id);
      const tgtId = parseInt(e.target_repo_id);

      const sourceList = depsByRepo.get(srcId) ?? [];
      const targetName = repoNameMap.get(tgtId) ?? `repo:${tgtId}`;
      sourceList.push({ repoName: targetName, direction: "depends-on" });
      depsByRepo.set(srcId, sourceList);

      const targetList = depsByRepo.get(tgtId) ?? [];
      const sourceName = repoNameMap.get(srcId) ?? `repo:${srcId}`;
      targetList.push({ repoName: sourceName, direction: "depended-by" });
      depsByRepo.set(tgtId, targetList);
    }

    for (const result of results) {
      if (result.type === "commit" || result.type === "dir") continue;
      const repoId = result.repoId ? parseInt(result.repoId) : currentRepoId;
      const edges = depsByRepo.get(repoId);
      if (edges && edges.length > 0) {
        result.crossRepoEdges = edges;
      }
    }
  } else {
    const db = await getSqlite(repoRoot);
    const repos = db.prepare("SELECT id, name FROM repos").all() as {
      id: number;
      name: string;
    }[];
    for (const r of repos) repoNameMap.set(r.id, r.name);

    // Build cross-repo edges lookup, filtered by scoped repo IDs if present
    let edgeQuery = `SELECT source_repo_id, target_repo_id FROM cross_repo_edges`;
    const edgeBindings: number[] = [];
    if (scopedRepoIds !== null && scopedRepoIds.length > 0) {
      const placeholders = scopedRepoIds.map(() => "?").join(",");
      edgeQuery += ` WHERE (source_repo_id IN (${placeholders}) OR target_repo_id IN (${placeholders}))`;
      edgeBindings.push(...scopedRepoIds, ...scopedRepoIds);
    }
    edgeQuery += ` GROUP BY source_repo_id, target_repo_id`;
    const allEdges = db.prepare(edgeQuery).all(...edgeBindings) as {
      source_repo_id: number;
      target_repo_id: number;
    }[];

    const depsByRepo = new Map<
      number,
      Array<{ repoName: string; direction: "depends-on" | "depended-by" }>
    >();
    for (const e of allEdges) {
      // source depends-on target
      const sourceList = depsByRepo.get(e.source_repo_id) ?? [];
      const targetName = repoNameMap.get(e.target_repo_id) ?? `repo:${e.target_repo_id}`;
      sourceList.push({ repoName: targetName, direction: "depends-on" });
      depsByRepo.set(e.source_repo_id, sourceList);

      // target depended-by source
      const targetList = depsByRepo.get(e.target_repo_id) ?? [];
      const sourceName = repoNameMap.get(e.source_repo_id) ?? `repo:${e.source_repo_id}`;
      targetList.push({ repoName: sourceName, direction: "depended-by" });
      depsByRepo.set(e.target_repo_id, targetList);
    }

    for (const result of results) {
      if (result.type === "commit" || result.type === "dir") continue;
      const repoId = result.repoId ? parseInt(result.repoId) : currentRepoId;
      const edges = depsByRepo.get(repoId);
      if (edges && edges.length > 0) {
        result.crossRepoEdges = edges;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Changed-file search — files indexed after a given timestamp
// ---------------------------------------------------------------------------

function parseSinceTimestamp(since: string): Date {
  // Relative formats: "1d", "7d", "2w", "3m"
  const relMatch = since.match(/^(\d+)([dwm])$/);
  if (relMatch) {
    const n = parseInt(relMatch[1]);
    const unit = relMatch[2];
    const now = new Date();
    switch (unit) {
      case "d":
        now.setDate(now.getDate() - n);
        break;
      case "w":
        now.setDate(now.getDate() - n * 7);
        break;
      case "m": {
        const day = now.getDate();
        now.setDate(1); // pin to 1st to avoid overflow
        now.setMonth(now.getMonth() - n);
        // Restore original day, clamped to end of target month
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        now.setDate(Math.min(day, lastDay));
        break;
      }
    }
    return now;
  }
  // ISO date string
  const d = new Date(since);
  if (isNaN(d.getTime())) throw new Error(`Invalid since value: ${since}`);
  return d;
}

export async function searchChanged(
  repoRoot: string,
  since: string,
  query?: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const config = await loadConfig(repoRoot);
  const sinceDate = parseSinceTimestamp(since);
  const sinceIso = sinceDate.toISOString();

  // Get the repo ID
  const resolved = await resolveRepoIds(repoRoot, options?.scope ?? "project", config);
  const repoIds = resolved.repoIds;
  if (repoIds.length === 0) return [];

  // Query files changed since the timestamp
  const changedPaths = new Set<string>();

  if (config.store === "pg") {
    const placeholders = repoIds.map((_, i) => `$${i + 2}`).join(",");
    const rows = await withRepoScope(repoIds, async (tx) => {
      return (await tx.unsafe(
        `SELECT file_path FROM files
         WHERE repo_id IN (${placeholders}) AND indexed_at >= $1`,
        [sinceIso, ...repoIds],
      )) as { file_path: string }[];
    });
    for (const r of rows) changedPaths.add(r.file_path);
  } else {
    const db = await getSqlite(repoRoot);
    const placeholders = repoIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT file_path FROM files
         WHERE repo_id IN (${placeholders}) AND indexed_at >= ?`,
      )
      .all(...repoIds, sinceIso) as { file_path: string }[];
    for (const r of rows) changedPaths.add(r.file_path);
  }

  if (changedPaths.size === 0) return [];

  // If no query, return changed files as basic results
  if (!query) {
    return Array.from(changedPaths).map((fp) => ({
      filePath: fp,
      cosineSimilarity: 0,
      finalScore: 0,
      type: "file",
      inProject: true,
    }));
  }

  // Run semantic search and intersect with changed files
  const semanticResults = await search(repoRoot, query, options);
  return semanticResults.filter((r) => r.type === "file" && changedPaths.has(r.filePath));
}

/**
 * Convenience wrapper — returns only file-type results (excludes "dir" and "commit").
 */
export async function searchFiles(
  repoRoot: string,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const all = await search(repoRoot, query, options);
  return all.filter((r) => r.type !== "dir" && r.type !== "commit");
}

/**
 * Convenience wrapper — returns only directory results.
 */
export async function searchDirectories(
  repoRoot: string,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const all = await search(repoRoot, query, options);
  return all.filter((r) => r.type === "dir");
}

/**
 * Convenience wrapper — returns only commit results.
 */
export async function searchCommits(
  repoRoot: string,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const all = await search(repoRoot, query, options);
  return all.filter((r) => r.type === "commit");
}
