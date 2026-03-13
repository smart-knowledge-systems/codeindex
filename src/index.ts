#!/usr/bin/env bun

import path from "path";
import { loadConfig, detectFormatter } from "./config";
import { ensurePgSchema, ensureSqliteSchema } from "./db/schema";
import { pgUnsafe, closePg } from "./db/pg";
import { closeSqlite } from "./db/sqlite";
import { walkRepo } from "./index/walker";
import { extractSkeleton, initParser } from "./index/skeleton";
import { formatAndHash } from "./index/formatter";
import { embed, embedSingle } from "./index/embedder";
import { getRepoOrigin, getRepoName, getFileCommits, getChangedFiles } from "./index/commits";
import { buildDirectoryIndex, updateAffectedDirectories } from "./index/directories";
import { search } from "./search/query";
import { installHook } from "./hooks/post-commit";
import { exportToSqlite } from "./db/export";
import type { SearchOptions } from "./search/types";

// ---------------------------------------------------------------------------
// init command
// ---------------------------------------------------------------------------

async function cmdInit(repoRoot: string) {
  const configPath = path.join(repoRoot, ".codeindex.json");
  const configFile = Bun.file(configPath);

  if (await configFile.exists()) {
    console.log("Already initialized.");
    return;
  }

  const gitDir = Bun.file(path.join(repoRoot, ".git"));
  if (!(await gitDir.exists())) {
    console.error("Error: not a git repository. Run `git init` first.");
    process.exit(1);
  }

  const store =
    process.env.PGHOST || process.env.DATABASE_URL ? "pg" : ("sqlite" as "pg" | "sqlite");
  const formatter = await detectFormatter(repoRoot);

  const config: Record<string, unknown> = { store };
  if (formatter) config.formatter = formatter;

  await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n");

  if (store === "sqlite") {
    await ensureSqliteSchema(repoRoot);
    const dbName = ".codeindex.db";
    console.log(`Initialized codeindex (store: sqlite, db: ${dbName})`);
  } else {
    await ensurePgSchema();
    console.log(`Initialized codeindex (store: pg)`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureRepo(repoRoot: string): Promise<number> {
  const config = await loadConfig(repoRoot);
  const origin = await getRepoOrigin(repoRoot);
  const name = await getRepoName(repoRoot);
  const formatter = config.formatter ?? (await detectFormatter(repoRoot));

  if (config.store === "pg") {
    await ensurePgSchema();
    const existing = await pgUnsafe("SELECT id FROM repos WHERE root_path = $1", [repoRoot]);
    if (existing.length > 0) return existing[0].id as number;

    const inserted = await pgUnsafe(
      "INSERT INTO repos (origin_url, root_path, name, formatter_cmd) VALUES ($1, $2, $3, $4) RETURNING id",
      [origin, repoRoot, name, formatter],
    );
    return inserted[0].id as number;
  } else {
    await ensureSqliteSchema(repoRoot);
    // TODO: SQLite repo upsert
    return 1;
  }
}

// ---------------------------------------------------------------------------
// reindex command
// ---------------------------------------------------------------------------

async function cmdReindex(repoRoot: string) {
  const config = await loadConfig(repoRoot);
  const repoId = await ensureRepo(repoRoot);
  const formatter = config.formatter ?? (await detectFormatter(repoRoot));

  console.log(`Indexing ${repoRoot} (repo_id=${repoId}, store=${config.store})`);

  await initParser();

  const allFiles: string[] = [];
  let indexed = 0;
  let skipped = 0;

  // Collect all files first for batch embedding
  const filesToEmbed: { filePath: string; skeleton: string; hash: string; fileType: string }[] = [];

  for await (const relPath of walkRepo(repoRoot)) {
    allFiles.push(relPath);
    const absPath = path.join(repoRoot, relPath);
    const content = await Bun.file(absPath).text();
    const ext = path.extname(relPath).toLowerCase() || ".txt";

    const { hash } = await formatAndHash(content, formatter);

    // Check if already indexed with same hash
    if (config.store === "pg") {
      const existing = await pgUnsafe(
        "SELECT id FROM files WHERE repo_id = $1 AND file_path = $2 AND content_hash = $3",
        [repoId, relPath, hash],
      );
      if (existing.length > 0) {
        skipped++;
        continue;
      }
    }

    const skeleton = await extractSkeleton(relPath, content, config.skeletonFallbackLines);
    filesToEmbed.push({ filePath: relPath, skeleton, hash, fileType: ext });
  }

  // Batch embed all skeletons
  if (filesToEmbed.length > 0) {
    console.log(`Embedding ${filesToEmbed.length} files...`);
    const embeddings = await embed(filesToEmbed.map((f) => f.skeleton));

    for (let i = 0; i < filesToEmbed.length; i++) {
      const f = filesToEmbed[i];
      const embedding = embeddings[i];

      if (config.store === "pg") {
        await pgUnsafe(
          `INSERT INTO files (repo_id, file_path, content_hash, skeleton, file_type, embedding)
           VALUES ($1, $2, $3, $4, $5, $6::vector)
           ON CONFLICT (repo_id, file_path) DO UPDATE SET
             content_hash = EXCLUDED.content_hash,
             skeleton = EXCLUDED.skeleton,
             file_type = EXCLUDED.file_type,
             embedding = EXCLUDED.embedding,
             indexed_at = now()`,
          [repoId, f.filePath, f.hash, f.skeleton, f.fileType, `[${embedding.join(",")}]`],
        );
      }
      indexed++;
    }
  }

  console.log(`Files: ${indexed} indexed, ${skipped} skipped (unchanged)`);

  // Index commits for each file
  console.log("Indexing commits...");
  let commitCount = 0;
  for (const relPath of allFiles) {
    const fileCommits = await getFileCommits(repoRoot, relPath, config.scoring.commitDepth);
    for (let rank = 0; rank < fileCommits.length; rank++) {
      const c = fileCommits[rank];

      if (config.store === "pg") {
        // Upsert commit
        const existing = await pgUnsafe(
          "SELECT id FROM commits WHERE repo_id = $1 AND commit_hash = $2",
          [repoId, c.hash],
        );

        let commitId: number;
        if (existing.length > 0) {
          commitId = existing[0].id as number;
        } else {
          const commitEmbedding = await embedSingle(c.message);
          const inserted = await pgUnsafe(
            `INSERT INTO commits (repo_id, commit_hash, message, embedding, authored_at)
             VALUES ($1, $2, $3, $4::vector, $5)
             ON CONFLICT (repo_id, commit_hash) DO UPDATE SET
               message = EXCLUDED.message,
               embedding = EXCLUDED.embedding
             RETURNING id`,
            [repoId, c.hash, c.message, `[${commitEmbedding.join(",")}]`, c.date],
          );
          commitId = inserted[0].id as number;
          commitCount++;
        }

        // Link file <-> commit
        const fileRows = await pgUnsafe(
          "SELECT id FROM files WHERE repo_id = $1 AND file_path = $2",
          [repoId, relPath],
        );
        if (fileRows.length > 0) {
          const fileId = fileRows[0].id as number;
          await pgUnsafe(
            `INSERT INTO file_commits (file_id, commit_id, recency)
             VALUES ($1, $2, $3)
             ON CONFLICT (file_id, commit_id) DO UPDATE SET recency = EXCLUDED.recency`,
            [fileId, commitId, rank + 1],
          );
        }
      }
    }
  }
  console.log(`Commits: ${commitCount} embedded`);

  // Build directory index
  console.log("Building directory index...");
  await buildDirectoryIndex(repoRoot, repoId, allFiles);
  console.log("Directory index complete.");

  console.log("Reindex complete.");
}

// ---------------------------------------------------------------------------
// update command (incremental, called by post-commit hook)
// ---------------------------------------------------------------------------

async function cmdUpdate(repoRoot: string, files: string[], commitHash?: string) {
  const config = await loadConfig(repoRoot);
  const repoId = await ensureRepo(repoRoot);
  const formatter = config.formatter ?? (await detectFormatter(repoRoot));

  await initParser();

  const changedFiles = files.length > 0 ? files : await getChangedFiles(repoRoot, commitHash);

  // Process changed files
  const filesToEmbed: { filePath: string; skeleton: string; hash: string; fileType: string }[] = [];

  for (const relPath of changedFiles) {
    const absPath = path.join(repoRoot, relPath);
    const file = Bun.file(absPath);
    if (!(await file.exists())) {
      // File was deleted — remove from index
      if (config.store === "pg") {
        await pgUnsafe("DELETE FROM files WHERE repo_id = $1 AND file_path = $2", [
          repoId,
          relPath,
        ]);
      }
      continue;
    }

    const content = await file.text();
    const ext = path.extname(relPath).toLowerCase() || ".txt";
    const { hash } = await formatAndHash(content, formatter);

    const existing = await pgUnsafe(
      "SELECT id FROM files WHERE repo_id = $1 AND file_path = $2 AND content_hash = $3",
      [repoId, relPath, hash],
    );
    if (existing.length > 0) continue;

    const skeleton = await extractSkeleton(relPath, content, config.skeletonFallbackLines);
    filesToEmbed.push({ filePath: relPath, skeleton, hash, fileType: ext });
  }

  if (filesToEmbed.length > 0) {
    const embeddings = await embed(filesToEmbed.map((f) => f.skeleton));
    for (let i = 0; i < filesToEmbed.length; i++) {
      const f = filesToEmbed[i];
      const embedding = embeddings[i];
      await pgUnsafe(
        `INSERT INTO files (repo_id, file_path, content_hash, skeleton, file_type, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)
         ON CONFLICT (repo_id, file_path) DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           skeleton = EXCLUDED.skeleton,
           file_type = EXCLUDED.file_type,
           embedding = EXCLUDED.embedding,
           indexed_at = now()`,
        [repoId, f.filePath, f.hash, f.skeleton, f.fileType, `[${embedding.join(",")}]`],
      );
    }
  }

  // Embed commit if provided
  if (commitHash) {
    const commitMsg = await getCommitMessage(repoRoot, commitHash);
    if (commitMsg) {
      const commitEmbedding = await embedSingle(commitMsg);
      const inserted = await pgUnsafe(
        `INSERT INTO commits (repo_id, commit_hash, message, embedding)
         VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (repo_id, commit_hash) DO NOTHING
         RETURNING id`,
        [repoId, commitHash, commitMsg, `[${commitEmbedding.join(",")}]`],
      );

      if (inserted.length > 0) {
        const commitId = inserted[0].id as number;
        for (const relPath of changedFiles) {
          const fileRows = await pgUnsafe(
            "SELECT id FROM files WHERE repo_id = $1 AND file_path = $2",
            [repoId, relPath],
          );
          if (fileRows.length > 0) {
            // Shift existing recencies
            await pgUnsafe("UPDATE file_commits SET recency = recency + 1 WHERE file_id = $1", [
              fileRows[0].id,
            ]);
            await pgUnsafe(
              `INSERT INTO file_commits (file_id, commit_id, recency)
               VALUES ($1, $2, 1)
               ON CONFLICT (file_id, commit_id) DO UPDATE SET recency = 1`,
              [fileRows[0].id, commitId],
            );
          }
        }
      }
    }
  }

  // Update affected directories
  await updateAffectedDirectories(repoRoot, repoId, changedFiles);

  console.log(`Updated ${filesToEmbed.length} files.`);
}

async function getCommitMessage(repoRoot: string, hash: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "-C", repoRoot, "log", "--format=%s", "-n", "1", hash], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  return (await new Response(proc.stdout).text()).trim();
}

// ---------------------------------------------------------------------------
// search command
// ---------------------------------------------------------------------------

async function cmdSearch(
  repoRoot: string,
  query: string,
  opts: {
    minScore?: number;
    topN?: number;
    scope?: string;
    includeSkeleton?: boolean;
    includeSummary?: boolean;
    json?: boolean;
    pretty?: boolean;
  },
) {
  const searchOpts: SearchOptions = {
    minScore: opts.minScore,
    topN: opts.topN,
    includeSkeleton: opts.includeSkeleton,
    includeSummary: opts.includeSummary,
  };

  if (opts.scope === "all") {
    searchOpts.scope = "all";
  } else if (opts.scope && opts.scope !== "project") {
    searchOpts.scope = opts.scope.split(",");
  }

  const results = await search(repoRoot, query, searchOpts);

  if (opts.pretty) {
    if (results.length === 0) {
      console.log("No results found.");
      return;
    }
    for (const r of results) {
      const prefix = r.inProject ? "" : `[${r.repoId}] `;
      console.log(
        `${prefix}${r.filePath}  (${r.type})  score=${r.finalScore.toFixed(3)}  sim=${r.cosineSimilarity.toFixed(3)}`,
      );
      if (r.skeleton) {
        const preview = r.skeleton.split("\n").slice(0, 5).join("\n");
        console.log(`  ${preview.replace(/\n/g, "\n  ")}`);
      }
      if (r.summary) {
        console.log(`  ${r.summary}`);
      }
    }
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
}

// ---------------------------------------------------------------------------
// export command
// ---------------------------------------------------------------------------

async function cmdExport(repoRoot: string, outPath: string) {
  const repoId = await ensureRepo(repoRoot);
  console.log(`Exporting repo_id=${repoId} to ${outPath}...`);
  await exportToSqlite(repoId, outPath);
  console.log("Export complete.");
}

// ---------------------------------------------------------------------------
// status command
// ---------------------------------------------------------------------------

async function cmdStatus(repoRoot: string) {
  const config = await loadConfig(repoRoot);

  if (config.store === "pg") {
    const repos = await pgUnsafe("SELECT * FROM repos WHERE root_path = $1", [repoRoot]);
    if (repos.length === 0) {
      console.log("Not indexed yet. Run: codeindex reindex");
      return;
    }
    const repoId = repos[0].id;
    const fileCount = await pgUnsafe("SELECT count(*) as cnt FROM files WHERE repo_id = $1", [
      repoId,
    ]);
    const dirCount = await pgUnsafe("SELECT count(*) as cnt FROM directories WHERE repo_id = $1", [
      repoId,
    ]);
    const commitCount = await pgUnsafe("SELECT count(*) as cnt FROM commits WHERE repo_id = $1", [
      repoId,
    ]);
    const lastIndexed = await pgUnsafe(
      "SELECT max(indexed_at) as last FROM files WHERE repo_id = $1",
      [repoId],
    );

    console.log(`Repo: ${repos[0].name} (${repos[0].root_path})`);
    console.log(`Store: PostgreSQL`);
    console.log(`Files: ${fileCount[0].cnt}`);
    console.log(`Directories: ${dirCount[0].cnt}`);
    console.log(`Commits: ${commitCount[0].cnt}`);
    console.log(`Last indexed: ${lastIndexed[0].last ?? "never"}`);
    console.log(`Formatter: ${repos[0].formatter_cmd ?? "auto-detect"}`);
  } else {
    console.log("SQLite status not yet implemented.");
  }
}

// ---------------------------------------------------------------------------
// config command
// ---------------------------------------------------------------------------

async function cmdConfig(repoRoot: string, args: string[]) {
  const config = await loadConfig(repoRoot);

  if (args.length === 0) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  // Parse --key value pairs and save to local config
  const updates: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    const value = args[i + 1];
    if (key === "formatter") updates.formatter = value;
    else if (key === "store") updates.store = value;
    else if (key === "decay")
      updates.scoring = { ...((updates.scoring as object) ?? {}), commitDecay: parseFloat(value) };
    else if (key === "commit-depth")
      updates.scoring = { ...((updates.scoring as object) ?? {}), commitDepth: parseInt(value) };
    else if (key === "alpha")
      updates.scoring = { ...((updates.scoring as object) ?? {}), alpha: parseFloat(value) };
    else if (key === "beta")
      updates.scoring = { ...((updates.scoring as object) ?? {}), beta: parseFloat(value) };
    else if (key === "gamma")
      updates.scoring = { ...((updates.scoring as object) ?? {}), gamma: parseFloat(value) };
    else if (key === "min-score")
      updates.scoring = { ...((updates.scoring as object) ?? {}), minScore: parseFloat(value) };
  }

  const localConfigPath = path.join(repoRoot, ".codeindex.json");
  const existing = await (async () => {
    try {
      return await Bun.file(localConfigPath).json();
    } catch {
      return {};
    }
  })();

  const merged = { ...existing, ...updates };
  await Bun.write(localConfigPath, JSON.stringify(merged, null, 2) + "\n");
  console.log("Config saved to .codeindex.json");
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const repoRoot = (() => {
    const pathIdx = args.indexOf("--path");
    return pathIdx !== -1 ? path.resolve(args[pathIdx + 1]) : process.cwd();
  })();

  try {
    switch (command) {
      case "init":
        await cmdInit(repoRoot);
        break;

      case "reindex":
        await cmdReindex(repoRoot);
        break;

      case "update": {
        const filesIdx = args.indexOf("--files");
        const commitIdx = args.indexOf("--commit");
        const files: string[] = [];
        if (filesIdx !== -1) {
          for (let i = filesIdx + 1; i < args.length; i++) {
            if (args[i].startsWith("--")) break;
            files.push(args[i]);
          }
        }
        const commitHash = commitIdx !== -1 ? args[commitIdx + 1] : undefined;
        await cmdUpdate(repoRoot, files, commitHash);
        break;
      }

      case "search": {
        const query = args[1];
        if (!query) {
          console.error("Usage: codeindex search <query> [options]");
          process.exit(1);
        }
        const getFlag = (flag: string) => {
          const idx = args.indexOf(flag);
          return idx !== -1 ? args[idx + 1] : undefined;
        };
        await cmdSearch(repoRoot, query, {
          minScore: getFlag("--min-score") ? parseFloat(getFlag("--min-score")!) : undefined,
          topN: getFlag("--top-n") ? parseInt(getFlag("--top-n")!) : undefined,
          scope: getFlag("--scope"),
          includeSkeleton: args.includes("--include-skeleton"),
          includeSummary: args.includes("--include-summary"),
          json: !args.includes("--pretty"),
          pretty: args.includes("--pretty"),
        });
        break;
      }

      case "export": {
        const outPath = (() => {
          const idx = args.indexOf("--out");
          return idx !== -1 ? args[idx + 1] : ".codeindex.db";
        })();
        await cmdExport(repoRoot, outPath);
        break;
      }

      case "install-hook":
        await installHook(repoRoot);
        console.log("Post-commit hook installed.");
        break;

      case "config":
        await cmdConfig(repoRoot, args.slice(1));
        break;

      case "status":
        await cmdStatus(repoRoot);
        break;

      default:
        console.log(`codeindex — semantic code search

Commands:
  init                 Initialize codeindex in current repo
  reindex              Full reindex of current repo
  update               Incremental update (called by hook)
    --files <paths>    Files to re-index
    --commit <hash>    Commit to embed and link
  search <query>       Semantic search
    --min-score <f>    Minimum score (default 0.3)
    --top-n <n>        Max results
    --scope <s>        project|all|name1,name2
    --include-skeleton Include skeleton text
    --include-summary  Include directory summaries
    --pretty           Human-readable output
  export               Export pg to sqlite
    --out <path>       Output path (default .codeindex.db)
  install-hook         Install post-commit git hook
  config               Show/set configuration
  status               Show index stats

Options:
  --path <dir>         Repo root (default: cwd)`);
        break;
    }
  } finally {
    await closePg();
    await closeSqlite();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
