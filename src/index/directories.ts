import path from "path";
import { createHash } from "crypto";
import { embedSingle } from "@easier-idx/embedding";
import { getProvider } from "../embedding-provider";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { serializeEmbedding } from "@easier-idx/core/db";
import { loadConfig } from "../config";
import { recordCost } from "../cost";
import { generateSummary as anthropicGenerateSummary } from "./providers/anthropic";
import { logEvent, hashPath } from "../logging";

type SummaryProviderKind = "claude-cli" | "anthropic-sdk";

/** Sort directory paths deepest-first for bottom-up processing. */
function sortByDepthDesc(dirs: Iterable<string>): string[] {
  return [...dirs].sort((a, b) => {
    const depthA = a === "." ? 0 : a.split("/").length;
    const depthB = b === "." ? 0 : b.split("/").length;
    return depthB - depthA;
  });
}

export async function buildDirectoryIndex(
  repoRoot: string,
  repoId: number,
  filePaths: string[],
): Promise<void> {
  const start = performance.now();
  const summaryProvider: SummaryProviderKind =
    (process.env.CODEINDEX_SUMMARY_PROVIDER as SummaryProviderKind) ?? "anthropic-sdk";

  // Collect all unique directories from file paths, bottom-up
  const dirSet = new Set<string>();
  for (const fp of filePaths) {
    let dir = path.dirname(fp);
    while (dir && dir !== ".") {
      dirSet.add(dir);
      dir = path.dirname(dir);
    }
    dirSet.add("."); // repo root
  }

  // Sort by depth (deepest first) for bottom-up processing
  const dirs = sortByDepthDesc(dirSet);

  const summaryCache = new Map<string, string>();
  let summariesGenerated = 0;
  let cacheHits = 0;

  for (const dirPath of dirs) {
    const result = await processDirectory(
      repoRoot,
      repoId,
      dirPath,
      filePaths,
      summaryCache,
      summaryProvider,
    );
    if (result.summary) {
      summaryCache.set(dirPath, result.summary);
    }
    if (result.cacheHit) cacheHits++;
    else summariesGenerated++;
  }

  logEvent({
    event: "index.directory.build.complete",
    directories_processed: dirs.length,
    summaries_generated: summariesGenerated,
    cache_hits: cacheHits,
    duration_ms: Math.round(performance.now() - start),
  });
}

interface ProcessDirectoryResult {
  summary: string | null;
  cacheHit: boolean;
}

async function processDirectory(
  repoRoot: string,
  repoId: number,
  dirPath: string,
  allFiles: string[],
  summaryCache: ReadonlyMap<string, string>,
  summaryProvider: SummaryProviderKind,
): Promise<ProcessDirectoryResult> {
  // Get immediate child files (not recursive)
  const childFiles = allFiles.filter((fp) => {
    const parent = path.dirname(fp);
    return parent === dirPath || (dirPath === "." && !fp.includes("/"));
  });

  // Get immediate child directories
  const childDirs = [
    ...new Set(
      allFiles.flatMap((fp) => {
        if (dirPath === ".") {
          const parts = fp.split("/");
          return parts.length > 1 ? [parts[0]] : [];
        }
        if (fp.startsWith(dirPath + "/")) {
          const rest = fp.slice(dirPath.length + 1);
          return rest.includes("/") ? [dirPath + "/" + rest.split("/")[0]] : [];
        }
        return [];
      }),
    ),
  ];

  // Fetch skeletons and content hashes for immediate child files from db
  const config = await loadConfig(repoRoot);
  const fileData = await Promise.all(
    childFiles.map(async (fp) => {
      if (config.store === "pg") {
        const rows = await pgUnsafe(
          "SELECT skeleton, content_hash FROM files WHERE repo_id = $1 AND file_path = $2",
          [repoId, fp],
        );
        if (rows.length > 0) {
          return {
            skeleton: rows[0].skeleton ? `--- ${fp} ---\n${rows[0].skeleton}` : null,
            hashPart: `${fp}:${rows[0].content_hash}`,
          };
        }
      } else {
        const db = await getSqlite(repoRoot);
        const rows = db
          .prepare("SELECT skeleton, content_hash FROM files WHERE repo_id = ? AND file_path = ?")
          .all(repoId, fp) as { skeleton: string | null; content_hash: string }[];
        if (rows.length > 0) {
          return {
            skeleton: rows[0].skeleton ? `--- ${fp} ---\n${rows[0].skeleton}` : null,
            hashPart: `${fp}:${rows[0].content_hash}`,
          };
        }
      }
      return null;
    }),
  );

  const skeletons = fileData.filter((d) => d?.skeleton).map((d) => d!.skeleton!);
  const hashParts = fileData.filter((d) => d !== null).map((d) => d!.hashPart);
  const concatSkeleton = skeletons.join("\n\n");

  // Gather child directory summaries and their hashes (already processed, bottom-up)
  const childSummaries: string[] = [];
  for (const cd of childDirs) {
    const cached = summaryCache.get(cd);
    if (cached) {
      childSummaries.push(`[${cd}]: ${cached}`);
      hashParts.push(`dir:${cd}:${createHash("sha256").update(cached).digest("hex").slice(0, 16)}`);
    }
  }

  // Compute children_hash from all child content hashes + child dir summary hashes
  const childrenHash =
    hashParts.length > 0
      ? createHash("sha256").update(hashParts.sort().join("\n")).digest("hex")
      : null;

  // Check if existing directory has the same children_hash — skip re-summarization if so
  let existingSummary: string | null = null;
  let existingHash: string | null = null;
  if (config.store === "pg") {
    const existing = await pgUnsafe(
      "SELECT summary, children_hash FROM directories WHERE repo_id = $1 AND dir_path = $2",
      [repoId, dirPath],
    );
    if (existing.length > 0) {
      existingSummary = existing[0].summary as string | null;
      existingHash = existing[0].children_hash as string | null;
    }
  } else {
    const db = await getSqlite(repoRoot);
    const existing = db
      .prepare("SELECT summary, children_hash FROM directories WHERE repo_id = ? AND dir_path = ?")
      .all(repoId, dirPath) as { summary: string | null; children_hash: string | null }[];
    if (existing.length > 0) {
      existingSummary = existing[0].summary;
      existingHash = existing[0].children_hash;
    }
  }

  const cacheHit = childrenHash !== null && existingHash === childrenHash && !!existingSummary;

  // Embed the concat skeleton
  let concatEmbedding: number[] | null = null;
  if (concatSkeleton.length > 0 && !cacheHit) {
    concatEmbedding = await embedSingle(getProvider(config), concatSkeleton.slice(0, 4000));
  }

  // Generate summary (skip on cache hit)
  let summary: string | null;
  if (cacheHit) {
    summary = existingSummary;
    logEvent({ event: "index.directory.cache_hit", dir_path_hash: hashPath(dirPath) });
  } else {
    summary = await generateSummary(concatSkeleton, childSummaries, summaryProvider);
  }

  // Embed the summary (skip on cache hit)
  let summaryEmbedding: number[] | null = null;
  if (summary && !cacheHit) {
    summaryEmbedding = await embedSingle(getProvider(config), summary);
  }

  // Skip upsert entirely on cache hit — existing data is still valid
  if (cacheHit) return { summary, cacheHit: true };

  // Upsert directory record with children_hash
  if (config.store === "pg") {
    await pgUnsafe(
      `INSERT INTO directories (repo_id, dir_path, concat_skeleton, concat_embedding, summary, summary_embedding, children_hash)
       VALUES ($1, $2, $3, $4::vector, $5, $6::vector, $7)
       ON CONFLICT (repo_id, dir_path) DO UPDATE SET
         concat_skeleton = EXCLUDED.concat_skeleton,
         concat_embedding = EXCLUDED.concat_embedding,
         summary = EXCLUDED.summary,
         summary_embedding = EXCLUDED.summary_embedding,
         children_hash = EXCLUDED.children_hash`,
      [
        repoId,
        dirPath,
        concatSkeleton || null,
        concatEmbedding ? `[${concatEmbedding.join(",")}]` : null,
        summary,
        summaryEmbedding ? `[${summaryEmbedding.join(",")}]` : null,
        childrenHash,
      ],
    );
  } else {
    const db = await getSqlite(repoRoot);
    const row = db
      .prepare(
        `INSERT INTO directories (repo_id, dir_path, concat_skeleton, summary, children_hash)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, dir_path) DO UPDATE SET
           concat_skeleton = excluded.concat_skeleton,
           summary = excluded.summary,
           children_hash = excluded.children_hash
         RETURNING id`,
      )
      .get(repoId, dirPath, concatSkeleton || null, summary, childrenHash) as { id: number };
    if (concatEmbedding) {
      db.prepare(`DELETE FROM dir_concat_embeddings WHERE dir_id = ?`).run(row.id);
      db.prepare(`INSERT INTO dir_concat_embeddings (dir_id, embedding) VALUES (?, ?)`).run(
        row.id,
        serializeEmbedding(concatEmbedding),
      );
    }
    if (summaryEmbedding) {
      db.prepare(`DELETE FROM dir_summary_embeddings WHERE dir_id = ?`).run(row.id);
      db.prepare(`INSERT INTO dir_summary_embeddings (dir_id, embedding) VALUES (?, ?)`).run(
        row.id,
        serializeEmbedding(summaryEmbedding),
      );
    }
  }

  return { summary, cacheHit: false };
}

const DIR_SUMMARY_SCHEMA = JSON.stringify({
  name: "dir_summary",
  schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "1-3 sentence summary of this directory purpose, key abstractions, and what a developer would find here.",
      },
    },
    required: ["summary"],
  },
});

async function generateSummaryViaCli(prompt: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      [
        "claude",
        "--print",
        "--model",
        "haiku",
        "--output-format",
        "json",
        "--json-schema",
        DIR_SUMMARY_SCHEMA,
      ],
      {
        stdin: new Response(prompt),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDECODE: "" },
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      logEvent({
        event: "index.directory.summary.error",
        "error.type": "cli_nonzero_exit",
        "error.code": exitCode,
      });
      return null;
    }

    // Estimate haiku tokens from char count (~4 chars per token)
    const estimatedInputTokens = Math.ceil(prompt.length / 4);
    const estimatedOutputTokens = Math.ceil(stdout.length / 4);
    await recordCost("summarize", "haiku", estimatedInputTokens, estimatedOutputTokens);

    const parsed = JSON.parse(stdout);
    return parsed.summary ?? null;
  } catch (err) {
    logEvent({
      event: "index.directory.summary.error",
      "error.type": "cli_failure",
      "error.message": err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function generateSummaryViaSdk(prompt: string): Promise<string | null> {
  try {
    const { summary, tokensIn, tokensOut } = await anthropicGenerateSummary(
      `${prompt}\n\nRespond with a JSON object containing a "summary" field: a 1-3 sentence summary of this directory's purpose, key abstractions, and what a developer would find here.`,
    );
    await recordCost("summarize", "haiku", tokensIn, tokensOut);

    // Try to parse as JSON, fall back to raw text
    try {
      const parsed = JSON.parse(summary);
      return parsed.summary ?? summary;
    } catch {
      return summary;
    }
  } catch (err) {
    logEvent({
      event: "index.directory.summary.error",
      "error.type": "sdk_failure",
      "error.message": err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Generate a directory summary using the specified provider. */
function generateSummary(
  concatSkeleton: string,
  childSummaries: string[],
  provider: SummaryProviderKind,
): Promise<string | null> {
  if (!concatSkeleton && childSummaries.length === 0) return Promise.resolve(null);

  const prompt = [
    "Summarize this directory.",
    "",
    "Files in this directory:",
    concatSkeleton || "(no files)",
    "",
    childSummaries.length > 0 ? `Subdirectory summaries:\n${childSummaries.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return provider === "claude-cli" ? generateSummaryViaCli(prompt) : generateSummaryViaSdk(prompt);
}

export async function updateAffectedDirectories(
  repoRoot: string,
  repoId: number,
  changedFiles: string[],
): Promise<void> {
  const start = performance.now();
  const summaryProvider: SummaryProviderKind =
    (process.env.CODEINDEX_SUMMARY_PROVIDER as SummaryProviderKind) ?? "anthropic-sdk";

  // Collect all affected directories from changed files
  const affectedDirs = new Set<string>();
  for (const fp of changedFiles) {
    let dir = path.dirname(fp);
    while (dir && dir !== ".") {
      affectedDirs.add(dir);
      dir = path.dirname(dir);
    }
    affectedDirs.add(".");
  }

  // Get all files for this repo to build the full picture
  const config = await loadConfig(repoRoot);
  let allFilePaths: string[];
  if (config.store === "pg") {
    const allFiles = await pgUnsafe("SELECT file_path FROM files WHERE repo_id = $1", [repoId]);
    allFilePaths = (allFiles as { file_path: string }[]).map((r) => r.file_path);
  } else {
    const db = await getSqlite(repoRoot);
    const allFiles = db.prepare("SELECT file_path FROM files WHERE repo_id = ?").all(repoId) as {
      file_path: string;
    }[];
    allFilePaths = allFiles.map((r) => r.file_path);
  }

  // Re-process only affected directories
  const dirs = sortByDepthDesc(affectedDirs);

  const summaryCache = new Map<string, string>();

  // Pre-load existing summaries for non-affected directories
  if (config.store === "pg") {
    const existingDirs = await pgUnsafe(
      "SELECT dir_path, summary FROM directories WHERE repo_id = $1",
      [repoId],
    );
    for (const d of existingDirs as { dir_path: string; summary: string | null }[]) {
      if (!affectedDirs.has(d.dir_path) && d.summary) {
        summaryCache.set(d.dir_path, d.summary);
      }
    }
  } else {
    const db = await getSqlite(repoRoot);
    const existingDirs = db
      .prepare("SELECT dir_path, summary FROM directories WHERE repo_id = ?")
      .all(repoId) as { dir_path: string; summary: string | null }[];
    for (const d of existingDirs) {
      if (!affectedDirs.has(d.dir_path) && d.summary) {
        summaryCache.set(d.dir_path, d.summary);
      }
    }
  }

  let summariesRegenerated = 0;
  for (const dirPath of dirs) {
    const result = await processDirectory(
      repoRoot,
      repoId,
      dirPath,
      allFilePaths,
      summaryCache,
      summaryProvider,
    );
    if (result.summary) {
      summaryCache.set(dirPath, result.summary);
    }
    if (!result.cacheHit) summariesRegenerated++;
  }

  logEvent({
    event: "index.directory.update.complete",
    affected_count: dirs.length,
    summaries_regenerated: summariesRegenerated,
    duration_ms: Math.round(performance.now() - start),
  });
}
