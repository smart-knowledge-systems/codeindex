import path from "path";
import { embedSingle } from "./embedder";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { serializeEmbedding } from "../db/util";
import { loadConfig } from "../config";

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

  // Fetch skeletons for immediate child files from db
  const config = await loadConfig(repoRoot);
  const skeletons: string[] = [];
  for (const fp of childFiles) {
    if (config.store === "pg") {
      const rows = await pgUnsafe(
        "SELECT skeleton FROM files WHERE repo_id = $1 AND file_path = $2",
        [repoId, fp],
      );
      if (rows.length > 0 && rows[0].skeleton) {
        skeletons.push(`--- ${fp} ---\n${rows[0].skeleton}`);
      }
    } else {
      const db = await getSqlite(repoRoot);
      const rows = db
        .prepare("SELECT skeleton FROM files WHERE repo_id = ? AND file_path = ?")
        .all(repoId, fp) as { skeleton: string | null }[];
      if (rows.length > 0 && rows[0].skeleton) {
        skeletons.push(`--- ${fp} ---\n${rows[0].skeleton}`);
      }
    }
  }

  const concatSkeleton = skeletons.join("\n\n");

  // Gather child directory summaries (already processed, bottom-up)
  const childSummaries: string[] = [];
  for (const cd of childDirSet) {
    const cached = summaryCache.get(cd);
    if (cached) {
      childSummaries.push(`[${cd}]: ${cached}`);
    }
  }

  // Embed the concat skeleton
  let concatEmbedding: number[] | null = null;
  if (concatSkeleton.length > 0) {
    concatEmbedding = await embedSingle(concatSkeleton.slice(0, 8000));
  }

  // Generate summary via claude --print --model haiku
  const summary = await generateSummary(concatSkeleton, childSummaries);

  // Embed the summary
  let summaryEmbedding: number[] | null = null;
  if (summary) {
    summaryEmbedding = await embedSingle(summary);
    summaryCache.set(dirPath, summary);
  }

  // Upsert directory record
  if (config.store === "pg") {
    await pgUnsafe(
      `INSERT INTO directories (repo_id, dir_path, concat_skeleton, concat_embedding, summary, summary_embedding)
       VALUES ($1, $2, $3, $4::vector, $5, $6::vector)
       ON CONFLICT (repo_id, dir_path) DO UPDATE SET
         concat_skeleton = EXCLUDED.concat_skeleton,
         concat_embedding = EXCLUDED.concat_embedding,
         summary = EXCLUDED.summary,
         summary_embedding = EXCLUDED.summary_embedding`,
      [
        repoId,
        dirPath,
        concatSkeleton || null,
        concatEmbedding ? `[${concatEmbedding.join(",")}]` : null,
        summary,
        summaryEmbedding ? `[${summaryEmbedding.join(",")}]` : null,
      ],
    );
  } else {
    const db = await getSqlite(repoRoot);
    const row = db
      .prepare(
        `INSERT INTO directories (repo_id, dir_path, concat_skeleton, summary)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (repo_id, dir_path) DO UPDATE SET
           concat_skeleton = excluded.concat_skeleton,
           summary = excluded.summary
         RETURNING id`,
      )
      .get(repoId, dirPath, concatSkeleton || null, summary) as { id: number };
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
