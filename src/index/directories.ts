import path from "path";
import { createHash } from "crypto";
import { embedSingle } from "./embedder";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { serializeEmbedding } from "../db/util";
import { loadConfig } from "../config";
import { recordCost } from "../cost";

export async function buildDirectoryIndex(
  repoRoot: string,
  repoId: number,
  filePaths: string[],
): Promise<void> {
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
  const dirs = [...dirSet].sort((a, b) => {
    const depthA = a === "." ? 0 : a.split("/").length;
    const depthB = b === "." ? 0 : b.split("/").length;
    return depthB - depthA;
  });

  const summaryCache = new Map<string, string>();

  for (const dirPath of dirs) {
    await processDirectory(repoRoot, repoId, dirPath, filePaths, summaryCache);
  }
}

async function processDirectory(
  repoRoot: string,
  repoId: number,
  dirPath: string,
  allFiles: string[],
  summaryCache: Map<string, string>,
): Promise<void> {
  // Get immediate child files (not recursive)
  const childFiles = allFiles.filter((fp) => {
    const parent = path.dirname(fp);
    return parent === dirPath || (dirPath === "." && !fp.includes("/"));
  });

  // Get immediate child directories
  const childDirSet = new Set<string>();
  for (const fp of allFiles) {
    const parts = fp.split("/");
    if (dirPath === ".") {
      if (parts.length > 1) childDirSet.add(parts[0]);
    } else if (fp.startsWith(dirPath + "/")) {
      const rest = fp.slice(dirPath.length + 1);
      const sub = rest.split("/")[0];
      if (rest.includes("/")) childDirSet.add(dirPath + "/" + sub);
    }
  }

  // Fetch skeletons and content hashes for immediate child files from db
  const config = await loadConfig(repoRoot);
  const skeletons: string[] = [];
  const hashParts: string[] = [];
  for (const fp of childFiles) {
    if (config.store === "pg") {
      const rows = await pgUnsafe(
        "SELECT skeleton, content_hash FROM files WHERE repo_id = $1 AND file_path = $2",
        [repoId, fp],
      );
      if (rows.length > 0) {
        if (rows[0].skeleton) skeletons.push(`--- ${fp} ---\n${rows[0].skeleton}`);
        hashParts.push(`${fp}:${rows[0].content_hash}`);
      }
    } else {
      const db = await getSqlite(repoRoot);
      const rows = db
        .prepare("SELECT skeleton, content_hash FROM files WHERE repo_id = ? AND file_path = ?")
        .all(repoId, fp) as { skeleton: string | null; content_hash: string }[];
      if (rows.length > 0) {
        if (rows[0].skeleton) skeletons.push(`--- ${fp} ---\n${rows[0].skeleton}`);
        hashParts.push(`${fp}:${rows[0].content_hash}`);
      }
    }
  }

  const concatSkeleton = skeletons.join("\n\n");

  // Gather child directory summaries and their hashes (already processed, bottom-up)
  const childSummaries: string[] = [];
  for (const cd of childDirSet) {
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

  const cacheHit = childrenHash !== null && existingHash === childrenHash && existingSummary;

  // Embed the concat skeleton
  let concatEmbedding: number[] | null = null;
  if (concatSkeleton.length > 0 && !cacheHit) {
    concatEmbedding = await embedSingle(concatSkeleton.slice(0, 4000));
  }

  // Generate summary via claude --print --model haiku (skip on cache hit)
  let summary: string | null;
  if (cacheHit) {
    summary = existingSummary;
    console.error(`  [cache hit] ${dirPath}`);
  } else {
    summary = await generateSummary(concatSkeleton, childSummaries);
  }

  // Embed the summary (skip on cache hit)
  let summaryEmbedding: number[] | null = null;
  if (summary && !cacheHit) {
    summaryEmbedding = await embedSingle(summary);
  }
  if (summary) {
    summaryCache.set(dirPath, summary);
  }

  // Skip upsert entirely on cache hit — existing data is still valid
  if (cacheHit) return;

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

async function generateSummary(
  concatSkeleton: string,
  childSummaries: string[],
): Promise<string | null> {
  if (!concatSkeleton && childSummaries.length === 0) return null;

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

    if (exitCode !== 0) return null;

    // Estimate haiku tokens from char count (~4 chars per token)
    const promptChars = prompt.length;
    const outputChars = stdout.length;
    const estimatedInputTokens = Math.ceil(promptChars / 4);
    const estimatedOutputTokens = Math.ceil(outputChars / 4);
    await recordCost("summarize", "haiku", estimatedInputTokens, estimatedOutputTokens);

    const parsed = JSON.parse(stdout);
    return parsed.summary ?? null;
  } catch {
    // claude CLI not available or failed — graceful fallback
    return null;
  }
}

export async function updateAffectedDirectories(
  repoRoot: string,
  repoId: number,
  changedFiles: string[],
): Promise<void> {
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
    allFilePaths = allFiles.map((r: { file_path: string }) => r.file_path);
  } else {
    const db = await getSqlite(repoRoot);
    const allFiles = db.prepare("SELECT file_path FROM files WHERE repo_id = ?").all(repoId) as {
      file_path: string;
    }[];
    allFilePaths = allFiles.map((r) => r.file_path);
  }

  // Re-process only affected directories
  const dirs = [...affectedDirs].sort((a, b) => {
    const depthA = a === "." ? 0 : a.split("/").length;
    const depthB = b === "." ? 0 : b.split("/").length;
    return depthB - depthA;
  });

  const summaryCache = new Map<string, string>();

  // Pre-load existing summaries for non-affected directories
  if (config.store === "pg") {
    const existingDirs = await pgUnsafe(
      "SELECT dir_path, summary FROM directories WHERE repo_id = $1",
      [repoId],
    );
    for (const d of existingDirs) {
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

  for (const dirPath of dirs) {
    await processDirectory(repoRoot, repoId, dirPath, allFilePaths, summaryCache);
  }
}
