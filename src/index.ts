#!/usr/bin/env bun

import path from "path";
import os from "os";
import { parseArgs, flag, hasFlag, warnUnknownFlags, type ParsedArgs } from "./cli";
import { loadConfig, detectFormatter } from "./config";
import { ensurePgSchema, ensureSqliteSchema } from "./db/schema";
import {
  getCurrentSchemaVersion,
  getLatestMigrationVersion,
  checkEmbeddingDimensions,
} from "./db/migrate";
import { getPg, pgUnsafe, closePg } from "./db/pg";
import { getSqlite, closeSqlite } from "./db/sqlite";
import { serializeEmbedding } from "./db/util";
import { walkRepo } from "./index/walker";
import { extractSkeletonWithEntries, initParser } from "./index/skeleton";
import { formatAndHash } from "./index/formatter";
import { scanForSecrets } from "./index/secrets";
import { embed, embedSingle, getProvider } from "./index/embedder";
import { getRepoOrigin, getRepoName, getFileCommits, getChangedFiles } from "./index/commits";
import { buildDirectoryIndex, updateAffectedDirectories } from "./index/directories";
import { search, searchChanged } from "./search/query";
import { installHook } from "./hooks/post-commit";
import { exportToSqlite, type ExportOptions } from "./db/export";
import { setCurrentRepo, getProjectedCost, checkCostCap } from "./cost";
import { generateIntent } from "./intent";
import { detectDrift } from "./drift";
import { repoAdd, repoRemove, repoList, repoGetAll, repoStatus, repoPurge } from "./repo";
import { parallelReindex } from "./index/parallel";
import { runHealthCheck } from "./check/runner";
import { runQualityCheck } from "./check/quality-runner";
import { extractImports, resolveImport } from "./index/imports";
import { discoverCrossRepoEdges } from "./index/cross-repo";
import { createToken, listTokens, revokeToken } from "./auth/tokens";
import { xrefSymbol, formatXrefTable, formatXrefJson } from "./xref";
import type { SearchOptions } from "./search/types";
import { formatError } from "./errors";
import { logEvent } from "./logging";
import { resetTelemetry } from "./telemetry";

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

  const gitExists = await Bun.file(path.join(repoRoot, ".git", "HEAD")).exists();
  if (!gitExists) {
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
    const db = await getSqlite(repoRoot);
    const existing = db.prepare("SELECT id FROM repos WHERE root_path = ?").all(repoRoot) as {
      id: number;
    }[];
    if (existing.length > 0) return existing[0].id;

    const result = db
      .prepare(
        "INSERT INTO repos (origin_url, root_path, name, formatter_cmd) VALUES (?, ?, ?, ?) RETURNING id",
      )
      .get(origin, repoRoot, name, formatter) as { id: number };
    return result.id;
  }
}

// ---------------------------------------------------------------------------
// import graph extraction
// ---------------------------------------------------------------------------

async function extractAndStoreImports(
  repoRoot: string,
  repoId: number,
  allFiles: Set<string>,
  store: "pg" | "sqlite",
): Promise<void> {
  // Build file ID map
  const fileIdMap = new Map<string, number>();

  if (store === "pg") {
    const rows = (await pgUnsafe("SELECT id, file_path FROM files WHERE repo_id = $1", [
      repoId,
    ])) as { id: string; file_path: string }[];
    for (const r of rows) fileIdMap.set(r.file_path, parseInt(r.id));
  } else {
    const db = await getSqlite(repoRoot);
    const rows = db.prepare("SELECT id, file_path FROM files WHERE repo_id = ?").all(repoId) as {
      id: number;
      file_path: string;
    }[];
    for (const r of rows) fileIdMap.set(r.file_path, r.id);
  }

  // Collect all edges first, then write atomically
  const edgesToInsert: Array<{
    sourceId: number;
    importedModule: string;
    resolvedId: number | null;
    language: string;
  }> = [];

  for (const relPath of allFiles) {
    const sourceId = fileIdMap.get(relPath);
    if (!sourceId) continue;

    const absPath = path.join(repoRoot, relPath);
    let content: string;
    try {
      content = (await Bun.file(absPath).text()).replace(/\0/g, "");
    } catch {
      continue;
    }

    const edges = extractImports(relPath, content);
    if (edges.length === 0) continue;

    for (const edge of edges) {
      const resolved = resolveImport(edge.importedModule, relPath, edge.language, allFiles);
      const resolvedId = resolved ? (fileIdMap.get(resolved) ?? null) : null;
      edgesToInsert.push({
        sourceId,
        importedModule: edge.importedModule,
        resolvedId,
        language: edge.language,
      });
    }
  }

  if (store === "pg") {
    const pg = await getPg();
    await pg.begin(async (tx) => {
      await tx.unsafe(
        "DELETE FROM file_imports WHERE source_file_id IN (SELECT id FROM files WHERE repo_id = $1)",
        [repoId],
      );
      for (const e of edgesToInsert) {
        await tx.unsafe(
          `INSERT INTO file_imports (source_file_id, imported_module, resolved_file_id, language)
           VALUES ($1, $2, $3, $4)`,
          [e.sourceId, e.importedModule, e.resolvedId, e.language],
        );
      }
    });
  } else {
    const sqliteDb = await getSqlite(repoRoot);
    const sqliteStmt = sqliteDb.prepare(
      `INSERT INTO file_imports (source_file_id, imported_module, resolved_file_id, language)
       VALUES (?, ?, ?, ?)`,
    );
    sqliteDb.transaction(() => {
      sqliteDb
        .prepare(
          "DELETE FROM file_imports WHERE source_file_id IN (SELECT id FROM files WHERE repo_id = ?)",
        )
        .run(repoId);
      for (const e of edgesToInsert) {
        sqliteStmt.run(e.sourceId, e.importedModule, e.resolvedId, e.language);
      }
    })();
  }
  console.log(`  ${edgesToInsert.length} import edges stored.`);
}

// ---------------------------------------------------------------------------
// reindex command
// ---------------------------------------------------------------------------

async function cmdReindex(repoRoot: string, dryRun = false, budget?: number, force = false) {
  const config = await loadConfig(repoRoot);
  if (budget != null) {
    config.costCap = { ...config.costCap, maxCostPerReindex: budget };
  }

  // Initialize embedding provider from config
  getProvider(config);

  const repoId = await ensureRepo(repoRoot);
  setCurrentRepo(repoId, repoRoot, config.store);

  // Check for embedding provider mismatch
  const currentProvider = config.embedding.provider ?? "openai";
  let existingProvider: string | null = null;
  if (config.store === "pg") {
    try {
      const rows = await pgUnsafe("SELECT embedding_provider FROM repos WHERE id = $1", [repoId]);
      if (rows.length > 0) existingProvider = rows[0].embedding_provider as string | null;
    } catch {
      /* column may not exist yet */
    }
  } else {
    const db = await getSqlite(repoRoot);
    try {
      const row = db.prepare("SELECT embedding_provider FROM repos WHERE id = ?").get(repoId) as {
        embedding_provider: string | null;
      } | null;
      if (row) existingProvider = row.embedding_provider;
    } catch {
      /* column may not exist yet */
    }
  }

  if (existingProvider && existingProvider !== currentProvider && !force) {
    console.error(
      `Error: Embedding provider changed from "${existingProvider}" to "${currentProvider}".`,
    );
    console.error("All existing embeddings must be regenerated. Use --force to proceed.");
    process.exit(1);
  }

  // Update repo with current embedding metadata
  if (config.store === "pg") {
    try {
      await pgUnsafe(
        "UPDATE repos SET embedding_provider = $1, embedding_dimensions = $2 WHERE id = $3",
        [currentProvider, config.embedding.dimensions, repoId],
      );
    } catch {
      /* column may not exist yet */
    }
  } else {
    const db = await getSqlite(repoRoot);
    try {
      db.prepare(
        "UPDATE repos SET embedding_provider = ?, embedding_dimensions = ? WHERE id = ?",
      ).run(currentProvider, config.embedding.dimensions, repoId);
    } catch {
      /* column may not exist yet */
    }
  }

  const formatter = config.formatter ?? (await detectFormatter(repoRoot));

  console.log(`Indexing ${repoRoot} (repo_id=${repoId}, store=${config.store})`);
  if (dryRun) console.log("(dry run — no changes will be made)");

  await initParser();

  const allFiles: string[] = [];
  let indexed = 0;
  let skipped = 0;

  // Collect all files first for batch embedding
  const filesToEmbed: {
    filePath: string;
    skeleton: string;
    skeletonEntries: string | null;
    hash: string;
    fileType: string;
  }[] = [];

  for await (const relPath of walkRepo(repoRoot)) {
    allFiles.push(relPath);
    const absPath = path.join(repoRoot, relPath);
    const content = (await Bun.file(absPath).text()).replace(/\0/g, "");

    const scan = scanForSecrets(content);
    if (scan.hasSecrets) {
      console.warn(`  SKIP ${relPath}: potential secrets (${scan.patterns.join(", ")})`);
      skipped++;
      continue;
    }

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
    } else {
      const db = await getSqlite(repoRoot);
      const existing = db
        .prepare("SELECT id FROM files WHERE repo_id = ? AND file_path = ? AND content_hash = ?")
        .all(repoId, relPath, hash) as { id: number }[];
      if (existing.length > 0) {
        skipped++;
        continue;
      }
    }

    const { text: skeleton, entries } = await extractSkeletonWithEntries(
      relPath,
      content,
      config.skeletonFallbackLines,
    );
    const skeletonEntries = entries.length > 0 ? JSON.stringify(entries) : null;
    filesToEmbed.push({ filePath: relPath, skeleton, skeletonEntries, hash, fileType: ext });
  }

  if (dryRun) {
    console.log(`Files: ${filesToEmbed.length} would be indexed, ${skipped} unchanged`);
    for (const f of filesToEmbed) {
      console.log(`  ${f.filePath} (${f.fileType})`);
    }
    const projected = getProjectedCost(
      filesToEmbed.length,
      filesToEmbed.length * 3,
      config.embedding.model,
    );
    console.log(`\nProjected cost:`);
    console.log(`  Embeddings: $${projected.embeddingCost.toFixed(4)}`);
    console.log(`  Summaries:  $${projected.summaryCost.toFixed(4)}`);
    console.log(`  Total:      $${projected.totalCost.toFixed(4)}`);
    if (config.costCap.maxCostPerReindex != null) {
      console.log(`  Budget:     $${config.costCap.maxCostPerReindex.toFixed(4)}`);
      if (projected.totalCost > config.costCap.maxCostPerReindex) {
        console.log(`  WARNING: projected cost exceeds budget`);
      }
    }
    return;
  }

  // Batch embed all skeletons
  if (filesToEmbed.length > 0) {
    process.stderr.write(`Indexing: 0/${filesToEmbed.length} files...`);
    const embeddings = await embed(filesToEmbed.map((f) => f.skeleton));

    if (config.store === "pg") {
      const pg = await getPg();
      await pg.begin(async (tx) => {
        for (let i = 0; i < filesToEmbed.length; i++) {
          const f = filesToEmbed[i];
          const embedding = embeddings[i];
          await tx.unsafe(
            `INSERT INTO files (repo_id, file_path, content_hash, skeleton, skeleton_entries, file_type, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
             ON CONFLICT (repo_id, file_path) DO UPDATE SET
               content_hash = EXCLUDED.content_hash,
               skeleton = EXCLUDED.skeleton,
               skeleton_entries = EXCLUDED.skeleton_entries,
               file_type = EXCLUDED.file_type,
               embedding = EXCLUDED.embedding,
               indexed_at = now()`,
            [
              repoId,
              f.filePath,
              f.hash,
              f.skeleton,
              f.skeletonEntries,
              f.fileType,
              `[${embedding.join(",")}]`,
            ],
          );
          indexed++;
          if (indexed % 10 === 0 || indexed === filesToEmbed.length) {
            process.stderr.write(`\rIndexing: ${indexed}/${filesToEmbed.length} files...`);
          }
        }
      });
    } else {
      const db = await getSqlite(repoRoot);
      const insertFile = db.prepare(
        `INSERT INTO files (repo_id, file_path, content_hash, skeleton, skeleton_entries, file_type)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, file_path) DO UPDATE SET
           content_hash = excluded.content_hash,
           skeleton = excluded.skeleton,
           skeleton_entries = excluded.skeleton_entries,
           file_type = excluded.file_type,
           indexed_at = datetime('now')
         RETURNING id`,
      );
      const deleteEmb = db.prepare(`DELETE FROM file_embeddings WHERE file_id = ?`);
      const insertEmb = db.prepare(
        `INSERT INTO file_embeddings (file_id, embedding) VALUES (?, ?)`,
      );
      db.transaction(() => {
        for (let i = 0; i < filesToEmbed.length; i++) {
          const f = filesToEmbed[i];
          const embedding = embeddings[i];
          const row = insertFile.get(
            repoId,
            f.filePath,
            f.hash,
            f.skeleton,
            f.skeletonEntries,
            f.fileType,
          ) as {
            id: number;
          };
          deleteEmb.run(row.id);
          insertEmb.run(row.id, serializeEmbedding(embedding));
          indexed++;
          if (indexed % 10 === 0 || indexed === filesToEmbed.length) {
            process.stderr.write(`\rIndexing: ${indexed}/${filesToEmbed.length} files...`);
          }
        }
      })();
    }
    process.stderr.write("\n");
  }

  console.log(`Files: ${indexed} indexed, ${skipped} skipped (unchanged)`);

  // Check cost cap after embedding batch
  if (config.costCap.maxCostPerReindex != null) {
    const cap = await checkCostCap(repoRoot, repoId);
    if (cap.current >= (config.costCap.warnAt ?? Infinity)) {
      console.warn(
        `Cost warning: $${cap.current.toFixed(4)} spent (limit: $${cap.limit?.toFixed(4)})`,
      );
    }
    if (cap.exceeded) {
      console.error(
        `Cost cap exceeded: $${cap.current.toFixed(4)} >= $${cap.limit?.toFixed(4)}. Aborting reindex.`,
      );
      return;
    }
  }

  // Index commits for each file
  console.log("Indexing commits...");
  let commitCount = 0;

  // Collect all commit data first (including async embedding)
  type CommitRecord = {
    relPath: string;
    hash: string;
    message: string;
    date: string;
    rank: number;
    embedding: number[] | null;
  };
  const commitRecords: CommitRecord[] = [];
  const seenHashes = new Set<string>();

  for (const relPath of allFiles) {
    const fileCommits = await getFileCommits(repoRoot, relPath, config.scoring.commitDepth);
    for (let rank = 0; rank < fileCommits.length; rank++) {
      const c = fileCommits[rank];
      let embedding: number[] | null = null;
      if (!seenHashes.has(c.hash)) {
        // Check if commit already exists in DB
        const exists =
          config.store === "pg"
            ? (
                await pgUnsafe("SELECT id FROM commits WHERE repo_id = $1 AND commit_hash = $2", [
                  repoId,
                  c.hash,
                ])
              ).length > 0
            : (
                (await getSqlite(repoRoot))
                  .prepare("SELECT id FROM commits WHERE repo_id = ? AND commit_hash = ?")
                  .all(repoId, c.hash) as { id: number }[]
              ).length > 0;
        if (!exists) {
          embedding = await embedSingle(c.message);
        }
        seenHashes.add(c.hash);
      }
      commitRecords.push({
        relPath,
        hash: c.hash,
        message: c.message,
        date: c.date,
        rank,
        embedding,
      });
    }
  }

  // Write all commit data in a transaction
  if (commitRecords.length > 0) {
    if (config.store === "pg") {
      const pg = await getPg();
      await pg.begin(async (tx) => {
        for (const cr of commitRecords) {
          let commitId: number;
          if (cr.embedding) {
            const inserted = await tx.unsafe(
              `INSERT INTO commits (repo_id, commit_hash, message, embedding, authored_at)
               VALUES ($1, $2, $3, $4::vector, $5)
               ON CONFLICT (repo_id, commit_hash) DO UPDATE SET
                 message = EXCLUDED.message,
                 embedding = EXCLUDED.embedding
               RETURNING id`,
              [repoId, cr.hash, cr.message, `[${cr.embedding.join(",")}]`, cr.date],
            );
            commitId = inserted[0].id as number;
            commitCount++;
          } else {
            const existing = await tx.unsafe(
              "SELECT id FROM commits WHERE repo_id = $1 AND commit_hash = $2",
              [repoId, cr.hash],
            );
            commitId = existing[0].id as number;
          }
          const fileRows = await tx.unsafe(
            "SELECT id FROM files WHERE repo_id = $1 AND file_path = $2",
            [repoId, cr.relPath],
          );
          if (fileRows.length > 0) {
            await tx.unsafe(
              `INSERT INTO file_commits (file_id, commit_id, recency)
               VALUES ($1, $2, $3)
               ON CONFLICT (file_id, commit_id) DO UPDATE SET recency = EXCLUDED.recency`,
              [fileRows[0].id, commitId, cr.rank + 1],
            );
          }
        }
      });
    } else {
      const db = await getSqlite(repoRoot);
      const upsertCommit = db.prepare(
        `INSERT INTO commits (repo_id, commit_hash, message, authored_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (repo_id, commit_hash) DO UPDATE SET message = excluded.message
         RETURNING id`,
      );
      const deleteCommitEmb = db.prepare(`DELETE FROM commit_embeddings WHERE commit_id = ?`);
      const insertCommitEmb = db.prepare(
        `INSERT INTO commit_embeddings (commit_id, embedding) VALUES (?, ?)`,
      );
      const selectCommit = db.prepare(
        "SELECT id FROM commits WHERE repo_id = ? AND commit_hash = ?",
      );
      const selectFile = db.prepare("SELECT id FROM files WHERE repo_id = ? AND file_path = ?");
      const upsertLink = db.prepare(
        `INSERT INTO file_commits (file_id, commit_id, recency)
         VALUES (?, ?, ?)
         ON CONFLICT (file_id, commit_id) DO UPDATE SET recency = excluded.recency`,
      );

      db.transaction(() => {
        for (const cr of commitRecords) {
          let commitId: number;
          if (cr.embedding) {
            const row = upsertCommit.get(repoId, cr.hash, cr.message, cr.date) as { id: number };
            commitId = row.id;
            deleteCommitEmb.run(commitId);
            insertCommitEmb.run(commitId, serializeEmbedding(cr.embedding));
            commitCount++;
          } else {
            const rows = selectCommit.all(repoId, cr.hash) as { id: number }[];
            commitId = rows[0].id;
          }
          const fileRows = selectFile.all(repoId, cr.relPath) as { id: number }[];
          if (fileRows.length > 0) {
            upsertLink.run(fileRows[0].id, commitId, cr.rank + 1);
          }
        }
      })();
    }
  }
  console.log(`Commits: ${commitCount} embedded`);

  // Build directory index
  console.log("Building directory index...");
  await buildDirectoryIndex(repoRoot, repoId, allFiles);
  console.log("Directory index complete.");

  // Extract and store import edges
  console.log("Extracting import graph...");
  await extractAndStoreImports(repoRoot, repoId, new Set(allFiles), config.store);
  console.log("Import graph complete.");

  logEvent({ event: "reindex", repo: repoRoot, files_indexed: indexed, files_skipped: skipped });
  console.log("Reindex complete.");
}

// ---------------------------------------------------------------------------
// update command (incremental, called by post-commit hook)
// ---------------------------------------------------------------------------

async function cmdUpdate(repoRoot: string, files: string[], commitHash?: string) {
  const config = await loadConfig(repoRoot);
  const repoId = await ensureRepo(repoRoot);
  setCurrentRepo(repoId, repoRoot, config.store);
  const formatter = config.formatter ?? (await detectFormatter(repoRoot));

  await initParser();

  const changedFiles = files.length > 0 ? files : await getChangedFiles(repoRoot, commitHash);

  // Process changed files
  const filesToEmbed: {
    filePath: string;
    skeleton: string;
    skeletonEntries: string | null;
    hash: string;
    fileType: string;
  }[] = [];

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
      } else {
        const db = await getSqlite(repoRoot);
        const rows = db
          .prepare("SELECT id FROM files WHERE repo_id = ? AND file_path = ?")
          .all(repoId, relPath) as { id: number }[];
        if (rows.length > 0) {
          db.transaction(() => {
            db.prepare("DELETE FROM file_embeddings WHERE file_id = ?").run(rows[0].id);
            db.prepare("DELETE FROM file_commits WHERE file_id = ?").run(rows[0].id);
            db.prepare("DELETE FROM files WHERE id = ?").run(rows[0].id);
          })();
        }
      }
      continue;
    }

    const content = await file.text();

    const scan = scanForSecrets(content);
    if (scan.hasSecrets) {
      console.warn(`  SKIP ${relPath}: potential secrets (${scan.patterns.join(", ")})`);
      continue;
    }

    const ext = path.extname(relPath).toLowerCase() || ".txt";
    const { hash } = await formatAndHash(content, formatter);

    if (config.store === "pg") {
      const existing = await pgUnsafe(
        "SELECT id FROM files WHERE repo_id = $1 AND file_path = $2 AND content_hash = $3",
        [repoId, relPath, hash],
      );
      if (existing.length > 0) continue;
    } else {
      const db = await getSqlite(repoRoot);
      const existing = db
        .prepare("SELECT id FROM files WHERE repo_id = ? AND file_path = ? AND content_hash = ?")
        .all(repoId, relPath, hash) as { id: number }[];
      if (existing.length > 0) continue;
    }

    const { text: skeleton, entries } = await extractSkeletonWithEntries(
      relPath,
      content,
      config.skeletonFallbackLines,
    );
    const skeletonEntries = entries.length > 0 ? JSON.stringify(entries) : null;
    filesToEmbed.push({ filePath: relPath, skeleton, skeletonEntries, hash, fileType: ext });
  }

  if (filesToEmbed.length > 0) {
    const embeddings = await embed(filesToEmbed.map((f) => f.skeleton));

    if (config.store === "pg") {
      const pg = await getPg();
      await pg.begin(async (tx) => {
        for (let i = 0; i < filesToEmbed.length; i++) {
          const f = filesToEmbed[i];
          const embedding = embeddings[i];
          await tx.unsafe(
            `INSERT INTO files (repo_id, file_path, content_hash, skeleton, skeleton_entries, file_type, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
             ON CONFLICT (repo_id, file_path) DO UPDATE SET
               content_hash = EXCLUDED.content_hash,
               skeleton = EXCLUDED.skeleton,
               skeleton_entries = EXCLUDED.skeleton_entries,
               file_type = EXCLUDED.file_type,
               embedding = EXCLUDED.embedding,
               indexed_at = now()`,
            [
              repoId,
              f.filePath,
              f.hash,
              f.skeleton,
              f.skeletonEntries,
              f.fileType,
              `[${embedding.join(",")}]`,
            ],
          );
        }
      });
    } else {
      const db = await getSqlite(repoRoot);
      const insertFile = db.prepare(
        `INSERT INTO files (repo_id, file_path, content_hash, skeleton, skeleton_entries, file_type)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, file_path) DO UPDATE SET
           content_hash = excluded.content_hash,
           skeleton = excluded.skeleton,
           skeleton_entries = excluded.skeleton_entries,
           file_type = excluded.file_type,
           indexed_at = datetime('now')
         RETURNING id`,
      );
      const deleteEmb2 = db.prepare(`DELETE FROM file_embeddings WHERE file_id = ?`);
      const insertEmb = db.prepare(
        `INSERT INTO file_embeddings (file_id, embedding) VALUES (?, ?)`,
      );
      db.transaction(() => {
        for (let i = 0; i < filesToEmbed.length; i++) {
          const f = filesToEmbed[i];
          const embedding = embeddings[i];
          const row = insertFile.get(
            repoId,
            f.filePath,
            f.hash,
            f.skeleton,
            f.skeletonEntries,
            f.fileType,
          ) as {
            id: number;
          };
          deleteEmb2.run(row.id);
          insertEmb.run(row.id, serializeEmbedding(embedding));
        }
      })();
    }
  }

  // Embed commit if provided
  if (commitHash) {
    const commitMsg = await getCommitMessage(repoRoot, commitHash);
    if (commitMsg) {
      const commitEmbedding = await embedSingle(commitMsg);
      if (config.store === "pg") {
        const pg = await getPg();
        await pg.begin(async (tx) => {
          const inserted = await tx.unsafe(
            `INSERT INTO commits (repo_id, commit_hash, message, embedding)
             VALUES ($1, $2, $3, $4::vector)
             ON CONFLICT (repo_id, commit_hash) DO NOTHING
             RETURNING id`,
            [repoId, commitHash, commitMsg, `[${commitEmbedding.join(",")}]`],
          );

          if (inserted.length > 0) {
            const commitId = inserted[0].id as number;
            for (const relPath of changedFiles) {
              const fileRows = await tx.unsafe(
                "SELECT id FROM files WHERE repo_id = $1 AND file_path = $2",
                [repoId, relPath],
              );
              if (fileRows.length > 0) {
                await tx.unsafe(
                  "UPDATE file_commits SET recency = recency + 1 WHERE file_id = $1",
                  [fileRows[0].id],
                );
                await tx.unsafe(
                  `INSERT INTO file_commits (file_id, commit_id, recency)
                   VALUES ($1, $2, 1)
                   ON CONFLICT (file_id, commit_id) DO UPDATE SET recency = 1`,
                  [fileRows[0].id, commitId],
                );
              }
            }
          }
        });
      } else {
        const db = await getSqlite(repoRoot);
        db.transaction(() => {
          const row = db
            .prepare(
              `INSERT INTO commits (repo_id, commit_hash, message)
               VALUES (?, ?, ?)
               ON CONFLICT (repo_id, commit_hash) DO NOTHING
               RETURNING id`,
            )
            .get(repoId, commitHash, commitMsg) as { id: number } | null;

          if (row) {
            db.prepare(`DELETE FROM commit_embeddings WHERE commit_id = ?`).run(row.id);
            db.prepare(`INSERT INTO commit_embeddings (commit_id, embedding) VALUES (?, ?)`).run(
              row.id,
              serializeEmbedding(commitEmbedding),
            );

            for (const relPath of changedFiles) {
              const fileRows = db
                .prepare("SELECT id FROM files WHERE repo_id = ? AND file_path = ?")
                .all(repoId, relPath) as { id: number }[];
              if (fileRows.length > 0) {
                db.prepare("UPDATE file_commits SET recency = recency + 1 WHERE file_id = ?").run(
                  fileRows[0].id,
                );
                db.prepare(
                  `INSERT INTO file_commits (file_id, commit_id, recency)
                   VALUES (?, ?, 1)
                   ON CONFLICT (file_id, commit_id) DO UPDATE SET recency = 1`,
                ).run(fileRows[0].id, row.id);
              }
            }
          }
        })();
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
    includeSnippet?: boolean;
    format?: string;
    json?: boolean;
    pretty?: boolean;
    lang?: string[];
    dir?: string[];
    since?: string;
    explain?: boolean;
    changedSince?: string;
  },
) {
  const searchOpts: SearchOptions = {
    minScore: opts.minScore,
    topN: opts.topN,
    includeSkeleton: opts.includeSkeleton,
    includeSummary: opts.includeSummary,
    includeSnippet: opts.includeSnippet,
    lang: opts.lang,
    dir: opts.dir,
    since: opts.since,
    explain: opts.explain,
  };

  if (opts.scope === "all") {
    searchOpts.scope = "all";
  } else if (opts.scope && opts.scope !== "project") {
    searchOpts.scope = opts.scope.split(",");
  }

  const results = opts.changedSince
    ? await searchChanged(repoRoot, opts.changedSince, query, searchOpts)
    : await search(repoRoot, query, searchOpts);

  // Resolve output format: --format takes precedence over --pretty/--json
  const format = opts.format ?? (opts.pretty ? "pretty" : "json");

  if (format === "compact") {
    for (const r of results) {
      const line = r.lineStart != null ? `:${r.lineStart}` : "";
      console.log(`${r.filePath}${line}:${r.finalScore.toFixed(3)}`);
    }
  } else if (format === "pretty") {
    if (results.length === 0) {
      console.log("No results found.");
    } else {
      const multiRepo = new Set(results.map((r) => r.repoName ?? r.repoId)).size > 1;
      for (const r of results) {
        const prefix = multiRepo && r.repoName ? `[${r.repoName}] ` : "";
        const lineInfo = r.lineStart != null ? ` L${r.lineStart}-L${r.lineEnd}` : "";
        console.log(
          `${prefix}${r.filePath}${lineInfo}  (${r.type})  score=${r.finalScore.toFixed(3)}  sim=${r.cosineSimilarity.toFixed(3)}`,
        );
        if (r.snippet) {
          const preview = r.snippet.split("\n").slice(0, 10).join("\n");
          console.log(`  ${preview.replace(/\n/g, "\n  ")}`);
        } else if (r.skeleton) {
          const preview = r.skeleton.split("\n").slice(0, 5).join("\n");
          console.log(`  ${preview.replace(/\n/g, "\n  ")}`);
        }
        if (r.summary) {
          console.log(`  ${r.summary}`);
        }
        if (r.explanation) {
          const e = r.explanation;
          console.log(`  [explain] ${e.formula}`);
          console.log(
            `    cosine=${e.cosineSimilarity.toFixed(3)} commit=${e.commitBoost.toFixed(3)} parent=${e.parentBoost.toFixed(3)}${e.childBoost != null ? ` child=${e.childBoost.toFixed(3)}` : ""}${e.keywordScore != null ? ` bm25=${e.keywordScore.toFixed(3)}` : ""}${e.lengthPenalty != null ? ` lenPen=${e.lengthPenalty.toFixed(3)}` : ""}`,
          );
        }
      }
    }
  } else {
    // json (default)
    console.log(JSON.stringify(results, null, 2));
  }

  // Zero-result diagnostics
  if (results.length === 0) {
    console.error(
      `No results found. Try: rg '${query}' or run 'codeindex doctor' to check index health.`,
    );
  }
}

// ---------------------------------------------------------------------------
// export command
// ---------------------------------------------------------------------------

async function cmdExport(repoRoot: string, outPath: string, opts: ExportOptions = {}) {
  const repoId = await ensureRepo(repoRoot);
  const exportOpts: ExportOptions = { ...opts, repoRoot };
  const redactions: string[] = [];
  if (exportOpts.redactEmbeddings !== false) redactions.push("embeddings");
  if (exportOpts.redactCommits) redactions.push("commits");
  if (exportOpts.excludePatterns?.length)
    redactions.push(`exclude(${exportOpts.excludePatterns.length} patterns)`);
  console.log(`Exporting repo_id=${repoId} to ${outPath}...`);
  if (redactions.length > 0) console.log(`Redacting: ${redactions.join(", ")}`);
  await exportToSqlite(repoId, outPath, exportOpts);
  console.log("Export complete.");
}

// ---------------------------------------------------------------------------
// status command
// ---------------------------------------------------------------------------

async function cmdStatus(repoRoot: string, showCost = false, showQuality = false) {
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
    const db = await getSqlite(repoRoot);
    const repos = db.prepare("SELECT * FROM repos WHERE root_path = ?").all(repoRoot) as {
      id: number;
      name: string;
      root_path: string;
      formatter_cmd: string | null;
    }[];
    if (repos.length === 0) {
      console.log("Not indexed yet. Run: codeindex reindex");
      return;
    }
    const repoId = repos[0].id;
    const fileCount = db
      .prepare("SELECT count(*) as cnt FROM files WHERE repo_id = ?")
      .get(repoId) as { cnt: number };
    const dirCount = db
      .prepare("SELECT count(*) as cnt FROM directories WHERE repo_id = ?")
      .get(repoId) as { cnt: number };
    const commitCount = db
      .prepare("SELECT count(*) as cnt FROM commits WHERE repo_id = ?")
      .get(repoId) as { cnt: number };
    const lastIndexed = db
      .prepare("SELECT max(indexed_at) as last FROM files WHERE repo_id = ?")
      .get(repoId) as { last: string | null };

    console.log(`Repo: ${repos[0].name} (${repos[0].root_path})`);
    console.log(`Store: SQLite`);
    console.log(`Files: ${fileCount.cnt}`);
    console.log(`Directories: ${dirCount.cnt}`);
    console.log(`Commits: ${commitCount.cnt}`);
    console.log(`Last indexed: ${lastIndexed.last ?? "never"}`);
    console.log(`Formatter: ${repos[0].formatter_cmd ?? "auto-detect"}`);
  }

  // Cost tracking output
  if (showCost) {
    const { getCostSummary } = await import("./cost");
    const costRows = await getCostSummary(repoRoot);
    if (costRows.length === 0) {
      console.log("\nCost: no cost events recorded");
    } else {
      console.log("\nCost breakdown:");
      console.log("  Operation       Model                  Tokens In   Tokens Out   Cost (USD)");
      console.log("  " + "-".repeat(75));
      let totalCost = 0;
      for (const row of costRows) {
        const op = row.operation.padEnd(15);
        const model = row.model.padEnd(22);
        const tokIn = String(row.totalTokensIn).padStart(10);
        const tokOut = String(row.totalTokensOut).padStart(12);
        const cost = `$${row.totalCostUsd.toFixed(4)}`.padStart(11);
        console.log(`  ${op} ${model} ${tokIn} ${tokOut} ${cost}`);
        totalCost += row.totalCostUsd;
      }
      console.log("  " + "-".repeat(75));
      console.log(`  Total: $${totalCost.toFixed(4)}`);
    }
  }

  // Quality metrics
  if (showQuality) {
    try {
      const report = await runQualityCheck(repoRoot);
      console.log("\nQuality Report:");
      console.log(`  Status: ${report.passed ? "PASS" : "FAIL"}`);
      console.log(`  Dataset queries: ${report.queryCount}`);
      for (const r of report.results) {
        const icon = r.result.passed ? "PASS" : "FAIL";
        console.log(`  [${icon}] ${r.policy}: ${r.result.message}`);
      }
    } catch (err) {
      console.log(`\nQuality check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// telemetry command
// ---------------------------------------------------------------------------

async function cmdTelemetry(parsed: ParsedArgs) {
  if (hasFlag(parsed, "reset")) {
    await resetTelemetry();
    console.log("Telemetry data reset.");
    return;
  }
  const telemetryFile = path.join(
    process.env.HOME ?? os.homedir(),
    ".config",
    "codeindex",
    "telemetry.jsonl",
  );
  try {
    const content = await Bun.file(telemetryFile).text();
    if (!content.trim()) {
      console.log("No telemetry data recorded. Set CODEINDEX_TELEMETRY=1 to enable.");
      return;
    }
    console.log(content);
  } catch {
    console.log("No telemetry data found. Set CODEINDEX_TELEMETRY=1 to enable.");
  }
}

// ---------------------------------------------------------------------------
// manifest command
// ---------------------------------------------------------------------------

async function cmdManifest(repoRoot: string) {
  const config = await loadConfig(repoRoot);

  // --- Indexed data from DB ---
  const dbStats = await (async () => {
    if (config.store === "pg") {
      const repos = await pgUnsafe("SELECT id FROM repos WHERE root_path = $1", [repoRoot]);
      if (repos.length === 0) return null;
      const repoId = repos[0].id;
      const fc = await pgUnsafe("SELECT count(*) as cnt FROM files WHERE repo_id = $1", [repoId]);
      const fp = (await pgUnsafe(
        "SELECT file_path FROM files WHERE repo_id = $1 ORDER BY file_path",
        [repoId],
      )) as { file_path: string }[];
      const dc = await pgUnsafe("SELECT count(*) as cnt FROM directories WHERE repo_id = $1", [
        repoId,
      ]);
      const cc = await pgUnsafe("SELECT count(*) as cnt FROM commits WHERE repo_id = $1", [repoId]);
      return {
        fileCount: parseInt(fc[0].cnt as string),
        filePaths: fp.map((r) => r.file_path),
        dirCount: parseInt(dc[0].cnt as string),
        commitCount: parseInt(cc[0].cnt as string),
      };
    } else {
      const db = await getSqlite(repoRoot);
      const repos = db.prepare("SELECT id FROM repos WHERE root_path = ?").all(repoRoot) as {
        id: number;
      }[];
      if (repos.length === 0) return null;
      const repoId = repos[0].id;
      const fc = db.prepare("SELECT count(*) as cnt FROM files WHERE repo_id = ?").get(repoId) as {
        cnt: number;
      };
      const fp = db
        .prepare("SELECT file_path FROM files WHERE repo_id = ? ORDER BY file_path")
        .all(repoId) as { file_path: string }[];
      const dc = db
        .prepare("SELECT count(*) as cnt FROM directories WHERE repo_id = ?")
        .get(repoId) as { cnt: number };
      const cc = db
        .prepare("SELECT count(*) as cnt FROM commits WHERE repo_id = ?")
        .get(repoId) as { cnt: number };
      return {
        fileCount: fc.cnt,
        filePaths: fp.map((r) => r.file_path),
        dirCount: dc.cnt,
        commitCount: cc.cnt,
      };
    }
  })();

  if (!dbStats) {
    console.log(JSON.stringify({ error: "Not indexed yet. Run: codeindex reindex" }));
    return;
  }

  const { fileCount, filePaths, dirCount, commitCount } = dbStats;

  // --- Walk repo to find skipped files and secret flags ---
  const indexedSet = new Set(filePaths);
  const skippedFiles: { path: string; reason: string }[] = [];
  const secretFlags: { path: string; patterns: string[] }[] = [];

  for await (const relPath of walkRepo(repoRoot)) {
    if (indexedSet.has(relPath)) continue;

    // Check if skipped due to secrets
    const absPath = path.join(repoRoot, relPath);
    try {
      const content = (await Bun.file(absPath).text()).replace(/\0/g, "");
      const scan = scanForSecrets(content);
      if (scan.hasSecrets) {
        skippedFiles.push({ path: relPath, reason: `secrets: ${scan.patterns.join(", ")}` });
        secretFlags.push({ path: relPath, patterns: scan.patterns });
        continue;
      }
    } catch {
      // File unreadable
    }

    skippedFiles.push({ path: relPath, reason: "not indexed (unchanged or new)" });
  }

  const manifest = {
    repoRoot,
    store: config.store,
    indexed: {
      files: { count: fileCount, paths: filePaths },
      directories: dirCount,
      commits: commitCount,
    },
    skipped: skippedFiles,
    secretFlags,
  };

  console.log(JSON.stringify(manifest, null, 2));
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
    else if (key === "parent-boost-multiplier")
      updates.scoring = {
        ...((updates.scoring as object) ?? {}),
        parentBoostMultiplier: parseFloat(value),
      };
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
// config --list command
// ---------------------------------------------------------------------------

async function cmdConfigList(repoRoot: string) {
  const config = await loadConfig(repoRoot);

  // Flatten config into key-value pairs with source info
  const entries: Array<{ key: string; value: unknown; source: string }> = [];

  function flatten(obj: Record<string, unknown>, prefix: string) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        flatten(v as Record<string, unknown>, key);
      } else {
        entries.push({ key, value: v, source: "config" });
      }
    }
  }

  flatten(config as unknown as Record<string, unknown>, "");

  // Check env var overrides
  const envOverrides: Record<string, string | undefined> = {
    "pg.host": process.env.PGHOST,
    "pg.port": process.env.PGPORT,
    "pg.database": process.env.PGDATABASE,
    "pg.user": process.env.PGUSER,
  };

  for (const entry of entries) {
    const envVal = envOverrides[entry.key];
    if (envVal !== undefined) {
      entry.source = "env";
      entry.value = envVal;
    }
  }

  // Print as aligned table
  const maxKeyLen = Math.max(...entries.map((e) => e.key.length));
  for (const e of entries) {
    const val = JSON.stringify(e.value);
    console.log(`${e.key.padEnd(maxKeyLen)}  ${val.padEnd(20)}  (${e.source})`);
  }
}

// ---------------------------------------------------------------------------
// doctor command
// ---------------------------------------------------------------------------

async function cmdDoctor(repoRoot: string) {
  let ok = true;
  const check = (label: string, pass: boolean, hint?: string) => {
    const icon = pass ? "[ok]" : "[!!]";
    console.log(`${icon} ${label}`);
    if (!pass && hint) console.log(`     ${hint}`);
    if (!pass) ok = false;
  };

  // 1. Git repo
  const gitExists = await Bun.file(path.join(repoRoot, ".git", "HEAD")).exists();
  check("Git repository", gitExists, "Run `git init` to initialize a repository.");

  // 2. OPENAI_API_KEY
  check(
    "OPENAI_API_KEY set",
    !!process.env.OPENAI_API_KEY,
    "Set OPENAI_API_KEY in your environment to enable embeddings.",
  );

  // 3. Config loadable
  let configOk = false;
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    config = await loadConfig(repoRoot);
    configOk = true;
  } catch {
    /* empty */
  }
  check(
    "Config loadable",
    configOk,
    "Check .codeindex.json for syntax errors. Run `codeindex init` to create one.",
  );

  // 4. Backend reachable
  if (config) {
    if (config.store === "pg") {
      try {
        await pgUnsafe("SELECT 1");
        check("PostgreSQL connection", true);
      } catch {
        check(
          "PostgreSQL connection",
          false,
          "Cannot connect to PostgreSQL. Check PGHOST, PGPORT, PGDATABASE env vars or pg config in .codeindex.json.",
        );
      }
    } else {
      try {
        await getSqlite(repoRoot);
        check("SQLite database", true);
      } catch {
        check("SQLite database", false, "Cannot open SQLite database file.");
      }
    }

    // 6. Schema created
    if (config.store === "pg") {
      try {
        const tables = await pgUnsafe(
          "SELECT count(*) as cnt FROM information_schema.tables WHERE table_name = 'files'",
        );
        check(
          "Schema created",
          (tables[0].cnt as number) > 0,
          "Run `codeindex init` or `codeindex reindex`.",
        );
      } catch {
        check("Schema created", false, "Run `codeindex init` or `codeindex reindex`.");
      }
    } else {
      try {
        const db = await getSqlite(repoRoot);
        const tables = db
          .prepare("SELECT count(*) as cnt FROM sqlite_master WHERE name = 'files'")
          .get() as { cnt: number };
        check("Schema created", tables.cnt > 0, "Run `codeindex init` or `codeindex reindex`.");
      } catch {
        check("Schema created", false, "Run `codeindex init` or `codeindex reindex`.");
      }
    }

    // Schema version check
    try {
      const current = await getCurrentSchemaVersion(config.store, repoRoot);
      const latest = await getLatestMigrationVersion(config.store);
      check(
        `Schema version (${current}/${latest})`,
        current >= latest,
        "Run `codeindex init` to apply pending migrations.",
      );
    } catch {
      check("Schema version", false, "Could not determine schema version.");
    }

    // Embedding dimension check (SQLite only — vec tables store dimension)
    if (config.store === "sqlite") {
      const dimWarning = await checkEmbeddingDimensions(repoRoot, config.embedding.dimensions);
      if (dimWarning) {
        check("Embedding dimensions", false, dimWarning);
      } else {
        check("Embedding dimensions", true);
      }
    }
  }

  // 5. claude CLI available
  try {
    const proc = Bun.spawn(["which", "claude"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    check(
      "claude CLI available",
      exitCode === 0,
      "Install claude CLI for directory summaries (optional).",
    );
  } catch {
    check("claude CLI available", false, "Install claude CLI for directory summaries (optional).");
  }

  // 6. Ollama check (if configured)
  if (config && config.embedding.provider === "ollama") {
    const { OllamaEmbeddingProvider } = await import("./index/providers/ollama");
    const ollama = new OllamaEmbeddingProvider(
      config.embedding.model,
      config.embedding.dimensions,
      config.embedding.ollamaUrl,
    );
    const { available, error } = await ollama.checkAvailability();
    check("Ollama server reachable", available, error);
  }

  console.log(ok ? "\nAll checks passed." : "\nSome checks failed — see above.");
}

// ---------------------------------------------------------------------------
// graph command
// ---------------------------------------------------------------------------

interface GraphNode {
  name: string;
  id: number;
}

interface GraphEdge {
  source: number;
  target: number;
  count: number;
}

async function cmdGraph(repoRoot: string, format: string) {
  const config = await loadConfig(repoRoot);

  let rows: Array<{ source_repo_id: number; target_repo_id: number; cnt: number }>;
  let repoNames: Map<number, string>;

  if (config.store === "pg") {
    const pg = await getPg();
    const edgeRows = await pg`
      SELECT source_repo_id, target_repo_id, COUNT(*) as cnt
      FROM cross_repo_edges
      GROUP BY source_repo_id, target_repo_id
    `;
    rows = edgeRows.map((r: Record<string, unknown>) => ({
      source_repo_id: Number(r.source_repo_id),
      target_repo_id: Number(r.target_repo_id),
      cnt: Number(r.cnt),
    }));

    const repoRows = await pg`SELECT id, name FROM repos`;
    repoNames = new Map(
      repoRows.map((r: Record<string, unknown>) => [Number(r.id), String(r.name)]),
    );
  } else {
    const db = await getSqlite(repoRoot);
    const edgeRows = db
      .prepare(
        `SELECT source_repo_id, target_repo_id, COUNT(*) as cnt
         FROM cross_repo_edges
         GROUP BY source_repo_id, target_repo_id`,
      )
      .all() as Array<{ source_repo_id: number; target_repo_id: number; cnt: number }>;
    rows = edgeRows;

    const repoRows = db.prepare(`SELECT id, name FROM repos`).all() as Array<{
      id: number;
      name: string;
    }>;
    repoNames = new Map(repoRows.map((r) => [r.id, r.name]));
  }

  if (rows.length === 0) {
    console.log("No cross-repo edges found.");
    return;
  }

  // Collect unique node IDs
  const nodeIds = new Set<number>();
  for (const r of rows) {
    nodeIds.add(r.source_repo_id);
    nodeIds.add(r.target_repo_id);
  }

  const nodes: GraphNode[] = [...nodeIds].map((id) => ({
    name: repoNames.get(id) ?? `repo_${id}`,
    id,
  }));

  const edges: GraphEdge[] = rows.map((r) => ({
    source: r.source_repo_id,
    target: r.target_repo_id,
    count: r.cnt,
  }));

  switch (format) {
    case "json":
      console.log(JSON.stringify({ nodes, edges }, null, 2));
      break;

    case "dot": {
      const dotLines = ["digraph cross_repo {"];
      for (const n of nodes) {
        dotLines.push(`  "${n.name}" [label="${n.name}"];`);
      }
      for (const e of edges) {
        const src = repoNames.get(e.source) ?? `repo_${e.source}`;
        const tgt = repoNames.get(e.target) ?? `repo_${e.target}`;
        dotLines.push(`  "${src}" -> "${tgt}" [label="${e.count}"];`);
      }
      dotLines.push("}");
      console.log(dotLines.join("\n"));
      break;
    }

    case "mermaid":
    default: {
      const mermaidLines = ["graph TD"];
      for (const e of edges) {
        const src = repoNames.get(e.source) ?? `repo_${e.source}`;
        const tgt = repoNames.get(e.target) ?? `repo_${e.target}`;
        // Sanitize names for Mermaid (replace special chars)
        const srcId = `r${e.source}`;
        const tgtId = `r${e.target}`;
        mermaidLines.push(`  ${srcId}["${src}"] -->|${e.count} edges| ${tgtId}["${tgt}"]`);
      }
      console.log(mermaidLines.join("\n"));
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// mcp-config command
// ---------------------------------------------------------------------------

async function cmdMcpConfig(parsed: ParsedArgs) {
  const transport = flag(parsed, "transport") ?? "stdio";
  const port = flag(parsed, "port") ?? "3100";

  if (transport === "sse") {
    const config = {
      mcpServers: {
        codeindex: {
          url: `http://localhost:${port}/sse`,
        },
      },
    };
    console.log(JSON.stringify(config, null, 2));
  } else {
    const config = {
      mcpServers: {
        codeindex: {
          command: "codeindex",
          args: ["mcp"],
        },
      },
    };
    console.log(JSON.stringify(config, null, 2));
  }
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

const HELP_TEXT = `codeindex — semantic code search

Commands:
  setup                Guided setup: database, repos, .indexignore, all in one
    --scan <dir>       Scan directory for git repos (multi-repo mode)
    --yes              Non-interactive, accept all defaults
    --store <type>     Force store type: pg | sqlite
    --dry-run          Show what would happen
  init                 Initialize codeindex in current repo
  reindex              Full reindex of current repo
    --dry-run          Report what would change and projected cost
    --budget <usd>     Set cost cap for this reindex (USD)
    --scope all        Reindex all registered repos in parallel
    --workers <n>      Number of parallel workers (default 3, with --scope all)
  update               Incremental update (called by hook)
    --files <paths>    Files to re-index
    --commit <hash>    Commit to embed and link
  search <query>       Semantic search
    --min-score <f>    Minimum score (default 0.3)
    --top-n <n>        Max results
    --scope <s>        project|all|name1,name2
    --lang <l>         Filter by language (ts,python,rust,go,java,c,cpp,cs)
    --dir <d>          Filter by directory prefix (src/api,lib)
    --since <t>        Filter by time (30d, 2w, 3m, or ISO date)
    --include-skeleton Include skeleton text
    --include-summary  Include directory summaries
    --include-snippet  Include code snippets with line numbers
    --explain          Show per-result score breakdown
    --format <f>       Output format: json (default), pretty, compact
    --pretty           Alias for --format pretty
    --json             Alias for --format json
  intent               Generate AGENTS.md from directory summaries
    --out <path>       Output path (default: stdout)
  drift                Detect stale Intent Nodes in AGENTS.md
    --threshold <f>    Drift threshold (default 0.3)
    --agents-md <path> Path to AGENTS.md (default: AGENTS.md)
    --out <path>       Output JSON path (default: stdout)
  repo <sub>           Manage repositories (add|remove|list|status|purge)
  export               Export pg to sqlite
    --out <path>       Output path (default .codeindex.db)
    --include-embeddings  Include embedding vectors (redacted by default)
    --redact-commits   Exclude commit data from export
    --exclude <globs>  Comma-separated glob patterns to exclude files
  install-hook         Install post-commit git hook
  config               Show/set configuration
  manifest             Audit trail: indexed files, skipped files, secret flags
  status               Show index stats
    --cost             Show token usage and cost breakdown
  serve                Start MCP server for AI agent integration
    --transport <t>    stdio (default) or sse
    --port <n>         Port for SSE transport (default 3100)
  check                Run health policy checks against the index
    --json             Output as JSON
  token <sub>           Manage access tokens (create|list|revoke)
    create --name --repos <id,id> [--expires <ISO>]
    list               List all tokens
    revoke --id <N>    Revoke a token
  mcp-config           Print MCP integration JSON config
    --transport <t>    stdio (default) or sse
    --port <n>         Port for SSE transport (default 3100)
  graph                Visualize cross-repo dependency graph
    --format <f>       json|mermaid|dot (default: mermaid)
  xref <symbol>        Cross-reference a symbol across repos
    --format <f>       json|table (default: table)
  doctor               Check environment and configuration

Options:
  --path <dir>         Repo root (default: cwd)
  --read-only          Block write operations (init, reindex, update)
  --version            Print version`;

const WRITE_COMMANDS = new Set(["init", "reindex", "update", "install-hook"]);

const SUBCOMMAND_HELP: Record<string, string> = {
  search:
    "Usage: codeindex search <query> [options]\n\nOptions:\n  --min-score <f>       Minimum score threshold (default 0.3)\n  --top-n <n>           Max results\n  --scope <s>           project|all|name1,name2\n  --lang <l>            Filter by language (ts,python,rust,go,java,c,cpp,cs)\n  --dir <d>             Filter by directory prefix\n  --since <t>           Filter by time (30d, 2w, 3m, or ISO date)\n  --include-skeleton    Include skeleton text\n  --include-summary     Include directory summaries\n  --include-snippet     Include code snippets with line numbers\n  --explain             Show per-result score breakdown\n  --format <f>          Output format: json (default), pretty, compact\n  --pretty              Alias for --format pretty\n  --json                Alias for --format json",
  reindex:
    "Usage: codeindex reindex [options]\n\nOptions:\n  --dry-run             Report what would change and projected cost\n  --budget <usd>        Set cost cap for this reindex (USD)\n  --scope all           Reindex all registered repos in parallel\n  --workers <n>         Number of parallel workers (default 3)\n  --force               Force full reindex even if unchanged",
  status:
    "Usage: codeindex status [options]\n\nOptions:\n  --cost                Show token usage and cost breakdown",
  serve:
    "Usage: codeindex serve [options]\n\nOptions:\n  --transport <t>       stdio (default) or sse\n  --port <n>            Port for SSE transport (default 3100)",
  init: "Usage: codeindex init\n\nInitializes codeindex in the current repository.",
  doctor: "Usage: codeindex doctor\n\nChecks environment and configuration health.",
  check:
    "Usage: codeindex check [options]\n\nOptions:\n  --json                Output as JSON\n  --quality             Run quality checks\n  --dataset <path>      Quality dataset path\n  --baseline <path>     Quality baseline path",
  intent:
    "Usage: codeindex intent [options]\n\nOptions:\n  --out <path>          Output path (default: stdout)",
  drift:
    "Usage: codeindex drift [options]\n\nOptions:\n  --threshold <f>       Drift threshold (default 0.3)\n  --agents-md <path>    Path to AGENTS.md (default: AGENTS.md)\n  --out <path>          Output JSON path (default: stdout)",
  repo: "Usage: codeindex repo <add|remove|list|status|purge>\n\nSubcommands:\n  add <path>            Register a repository\n  remove <name>         Unregister a repository\n  list                  List all registered repos\n  status [name]         Show repo status\n  purge <name> [--force] Remove repo and all its data",
  token:
    "Usage: codeindex token <create|list|revoke>\n\nSubcommands:\n  create --name <name> --repos <id,id> [--expires <ISO>]\n  list                  List all tokens\n  revoke --id <N>       Revoke a token",
  graph:
    "Usage: codeindex graph [options]\n\nOptions:\n  --format <f>          Output format: mermaid (default), json, dot",
  xref: "Usage: codeindex xref <symbol> [options]\n\nOptions:\n  --format <f>          Output format: table (default), json",
  "mcp-config":
    "Usage: codeindex mcp-config [options]\n\nOptions:\n  --transport <t>       stdio (default) or sse\n  --port <n>            Port for SSE transport (default 3100)",
  config:
    "Usage: codeindex config [--list | --key value ...]\n\nOptions:\n  --list                Show all config values with sources",
  export:
    "Usage: codeindex export [options]\n\nOptions:\n  --out <path>              Output path (default .codeindex.db)\n  --include-embeddings      Include embedding vectors (redacted by default)\n  --redact-commits          Exclude commit data from export\n  --exclude <globs>         Comma-separated glob patterns to exclude files",
};

async function main() {
  const parsed = parseArgs(process.argv);
  const repoRoot = flag(parsed, "path") ? path.resolve(flag(parsed, "path")!) : process.cwd();

  // --version: print version and exit
  if (hasFlag(parsed, "version")) {
    const pkg = await Bun.file(path.join(import.meta.dir, "../package.json")).json();
    console.log(pkg.version);
    process.exit(0);
  }

  // Per-subcommand --help
  if (hasFlag(parsed, "help") && parsed.command && SUBCOMMAND_HELP[parsed.command]) {
    console.log(SUBCOMMAND_HELP[parsed.command]);
    process.exit(0);
  }

  // Read-only guard: block write operations when --read-only flag or config is set
  if (WRITE_COMMANDS.has(parsed.command)) {
    const isReadOnlyFlag = hasFlag(parsed, "read-only");
    let isReadOnlyConfig = false;
    try {
      const cfg = await loadConfig(repoRoot);
      isReadOnlyConfig = cfg.readOnly === true;
    } catch {
      // config may not exist yet (e.g. during init)
    }
    if (isReadOnlyFlag || isReadOnlyConfig) {
      console.error(
        `Error: write operation "${parsed.command}" is blocked in read-only mode.\n` +
          "Read-only mode is intended for CI/CD environments where the index should not be modified.\n" +
          "Remove --read-only flag or set readOnly: false in .codeindex.json to allow writes.",
      );
      process.exit(1);
    }
  }

  // Warn about unrecognized flags
  const GLOBAL_FLAGS = [
    "help",
    "version",
    "read-only",
    "json",
    "pretty",
    "explain",
    "min-score",
    "top-n",
    "lang",
    "dir",
    "since",
    "format",
    "scope",
    "out",
    "transport",
    "port",
    "workers",
    "budget",
    "files",
    "commit",
    "threshold",
    "config-name",
    "repo",
    "output",
    "exclude",
    "cost",
    "include-skeleton",
    "include-summary",
    "include-snippet",
    "dry-run",
    "quality",
    "list",
    "reset",
    "validate",
    "alpha",
    "beta",
    "gamma",
    "decay",
    "parent-boost-multiplier",
    "changed-since",
    "force",
    "scan",
    "store",
    "yes",
    "single",
    "skip-doctor",
    "name",
    "repos",
    "expires",
    "id",
    "path",
    "dataset",
    "baseline",
    "agents-md",
  ];
  warnUnknownFlags(parsed, GLOBAL_FLAGS);

  try {
    switch (parsed.command) {
      case "init":
        await cmdInit(repoRoot);
        break;

      case "setup": {
        const { cmdSetup } = await import("./setup");
        await cmdSetup(repoRoot, {
          scanDir: flag(parsed, "scan"),
          single: hasFlag(parsed, "single"),
          yes: hasFlag(parsed, "yes"),
          store: flag(parsed, "store") as "pg" | "sqlite" | undefined,
          skipDoctor: hasFlag(parsed, "skip-doctor"),
          dryRun: hasFlag(parsed, "dry-run"),
        });
        break;
      }

      case "reindex": {
        const budgetStr = flag(parsed, "budget");
        const scope = flag(parsed, "scope");

        if (scope === "all") {
          const allRepos = await repoGetAll(repoRoot);
          if (allRepos.length === 0) {
            console.error("No repos registered. Use `codeindex repo add <path>` first.");
            process.exit(1);
          }
          const workersStr = flag(parsed, "workers");
          const workers = workersStr ? parseInt(workersStr) : 3;
          const budget = budgetStr ? parseFloat(budgetStr) : 0;

          const results = await parallelReindex(
            allRepos.map((r) => ({ root: r.root_path, name: r.name })),
            workers,
            budget,
          );

          // Print summary
          console.log("\nReindex Summary:");
          for (const r of results) {
            const icon = r.status === "ok" ? "OK" : "FAIL";
            console.log(`  [${icon}] ${r.repo}${r.error ? `: ${r.error}` : ""}`);
          }
          const ok = results.filter((r) => r.status === "ok").length;
          const fail = results.filter((r) => r.status === "error").length;
          console.log(`\n${ok} succeeded, ${fail} failed`);

          if (fail > 0) process.exit(1);
        } else {
          await cmdReindex(
            repoRoot,
            hasFlag(parsed, "dry-run"),
            budgetStr ? parseFloat(budgetStr) : undefined,
            hasFlag(parsed, "force"),
          );
        }
        break;
      }

      case "update": {
        const filesRaw = flag(parsed, "files");
        const files = filesRaw ? filesRaw.split(",") : parsed.positional;
        await cmdUpdate(repoRoot, files, flag(parsed, "commit"));
        break;
      }

      case "search": {
        const query = parsed.positional[0];
        if (!query) {
          console.error("Usage: codeindex search <query> [options]");
          process.exit(1);
        }
        const minScoreStr = flag(parsed, "min-score");
        const topNStr = flag(parsed, "top-n");
        const langRaw = flag(parsed, "lang");
        const dirRaw = flag(parsed, "dir");
        await cmdSearch(repoRoot, query, {
          minScore: minScoreStr ? parseFloat(minScoreStr) : undefined,
          topN: topNStr ? parseInt(topNStr) : undefined,
          scope: flag(parsed, "scope"),
          includeSkeleton: hasFlag(parsed, "include-skeleton"),
          includeSummary: hasFlag(parsed, "include-summary"),
          includeSnippet: hasFlag(parsed, "include-snippet"),
          format: flag(parsed, "format"),
          json: hasFlag(parsed, "json"),
          pretty: hasFlag(parsed, "pretty"),
          lang: langRaw ? langRaw.split(",") : undefined,
          dir: dirRaw ? dirRaw.split(",") : undefined,
          since: flag(parsed, "since"),
          explain: hasFlag(parsed, "explain"),
          changedSince: flag(parsed, "changed-since"),
        });
        break;
      }

      case "export": {
        const excludeRaw = flag(parsed, "exclude");
        await cmdExport(repoRoot, flag(parsed, "out") ?? ".codeindex.db", {
          redactEmbeddings: !hasFlag(parsed, "include-embeddings"),
          redactCommits: hasFlag(parsed, "redact-commits"),
          excludePatterns: excludeRaw ? excludeRaw.split(",") : undefined,
        });
        break;
      }

      case "install-hook":
        await installHook(repoRoot);
        console.log("Post-commit hook installed.");
        break;

      case "config":
        if (hasFlag(parsed, "list")) {
          await cmdConfigList(repoRoot);
        } else {
          await cmdConfig(repoRoot, process.argv.slice(3));
        }
        break;

      case "manifest":
        await cmdManifest(repoRoot);
        break;

      case "check": {
        const report = await runHealthCheck(repoRoot);
        if (hasFlag(parsed, "json")) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(`Health check: ${report.repo}`);
          console.log("─".repeat(50));
          for (const r of report.results) {
            const icon = r.result.passed ? "✓" : r.severity === "error" ? "✗" : "⚠";
            console.log(`  ${icon} [${r.severity}] ${r.policy}: ${r.result.message}`);
          }
          console.log("─".repeat(50));
          console.log(report.passed ? "All checks passed." : "Some checks failed.");
        }
        let exitCode = report.passed ? 0 : 1;

        if (hasFlag(parsed, "quality")) {
          const datasetPath = flag(parsed, "dataset");
          const baselinePath = flag(parsed, "baseline");
          const qualityReport = await runQualityCheck(repoRoot, datasetPath, baselinePath);
          if (hasFlag(parsed, "json")) {
            console.log(JSON.stringify(qualityReport, null, 2));
          } else {
            console.log("\nQuality check:");
            console.log("─".repeat(50));
            for (const r of qualityReport.results) {
              const icon = r.result.passed ? "✓" : "✗";
              console.log(`  ${icon} ${r.policy}: ${r.result.message}`);
            }
            console.log("─".repeat(50));
            console.log(
              qualityReport.passed ? "All quality checks passed." : "Quality checks failed.",
            );
          }
          if (!qualityReport.passed) exitCode = 1;
        }
        if (exitCode !== 0) process.exit(exitCode);
        break;
      }

      case "cross-repo": {
        console.log("Discovering cross-repo relationships...");
        const edges = await discoverCrossRepoEdges(repoRoot);
        if (edges.length === 0) {
          console.log("No cross-repo relationships found.");
        } else {
          console.log(`Found ${edges.length} cross-repo edge(s).`);
          if (hasFlag(parsed, "json")) {
            console.log(JSON.stringify(edges, null, 2));
          } else {
            for (const e of edges) {
              console.log(
                `  repo:${e.sourceRepoId} → repo:${e.targetRepoId}  ${e.importedModule} [${e.language}]`,
              );
            }
          }
        }
        break;
      }

      case "token": {
        const sub = parsed.positional[0];
        switch (sub) {
          case "create": {
            const name = flag(parsed, "name");
            const repos = flag(parsed, "repos");
            if (!name || !repos) {
              console.error("Usage: codeindex token create --name <name> --repos <id1,id2,...>");
              process.exit(1);
            }
            const rawIds = repos.split(",").map((s) => s.trim());
            const invalidIds = rawIds.filter((s) => isNaN(parseInt(s, 10)));
            if (invalidIds.length > 0) {
              console.error(
                `Error: invalid repo IDs: ${invalidIds.join(", ")} — all IDs must be numeric`,
              );
              process.exit(1);
            }
            const repoIds = rawIds.map((s) => parseInt(s, 10));
            if (repoIds.length === 0) {
              console.error("Error: --repos must be a comma-separated list of numeric IDs");
              process.exit(1);
            }
            const expiresAt = flag(parsed, "expires");
            if (expiresAt && isNaN(new Date(expiresAt).getTime())) {
              console.error(`Error: --expires "${expiresAt}" is not a valid ISO date string`);
              process.exit(1);
            }
            const plaintext = await createToken(repoRoot, name, repoIds, expiresAt);
            console.log(`Token created: ${plaintext}`);
            console.log("Store this token securely — it cannot be retrieved again.");
            break;
          }
          case "list": {
            const tokens = await listTokens(repoRoot);
            if (tokens.length === 0) {
              console.log("No tokens found.");
            } else {
              console.log(
                `${"ID".padEnd(5)}${"Name".padEnd(20)}${"Repos".padEnd(15)}${"Revoked".padEnd(10)}Expires`,
              );
              for (const t of tokens) {
                console.log(
                  `${String(t.id).padEnd(5)}${t.name.padEnd(20)}${t.repoIds.join(",").padEnd(15)}${String(t.revoked).padEnd(10)}${t.expiresAt ?? "-"}`,
                );
              }
            }
            break;
          }
          case "revoke": {
            const id = flag(parsed, "id");
            if (!id) {
              console.error("Usage: codeindex token revoke --id <token_id>");
              process.exit(1);
            }
            const parsedId = parseInt(id, 10);
            if (isNaN(parsedId)) {
              console.error("Error: --id must be a numeric token ID");
              process.exit(1);
            }
            await revokeToken(repoRoot, parsedId);
            console.log(`Token ${id} revoked.`);
            break;
          }
          default:
            console.error("Usage: codeindex token <create|list|revoke>");
            process.exit(1);
        }
        break;
      }

      case "status":
        await cmdStatus(repoRoot, hasFlag(parsed, "cost"), hasFlag(parsed, "quality"));
        break;

      case "telemetry":
        await cmdTelemetry(parsed);
        break;

      case "doctor":
        await cmdDoctor(repoRoot);
        break;

      case "intent":
        await generateIntent(repoRoot, flag(parsed, "out"));
        break;

      case "drift": {
        const agentsMdPath = flag(parsed, "agents-md") ?? "AGENTS.md";
        const thresholdStr = flag(parsed, "threshold");
        await detectDrift(
          repoRoot,
          agentsMdPath,
          thresholdStr ? parseFloat(thresholdStr) : undefined,
          flag(parsed, "out"),
        );
        break;
      }

      case "repo": {
        const subCmd = parsed.positional[0];
        switch (subCmd) {
          case "add":
            await repoAdd(repoRoot, parsed.positional[1] ?? repoRoot);
            break;
          case "remove":
            if (!parsed.positional[1]) {
              console.error("Usage: codeindex repo remove <name>");
              process.exit(1);
            }
            await repoRemove(repoRoot, parsed.positional[1]);
            break;
          case "list":
            await repoList(repoRoot);
            break;
          case "status":
            await repoStatus(repoRoot, parsed.positional[1]);
            break;
          case "purge":
            if (!parsed.positional[1]) {
              console.error("Usage: codeindex repo purge <name> [--force]");
              process.exit(1);
            }
            await repoPurge(repoRoot, parsed.positional[1], hasFlag(parsed, "force"));
            break;
          default:
            console.error("Usage: codeindex repo <add|remove|list|status|purge>");
            process.exit(1);
        }
        break;
      }

      case "graph": {
        const graphFormat = flag(parsed, "format") ?? "mermaid";
        await cmdGraph(repoRoot, graphFormat);
        break;
      }

      case "xref": {
        const symbolName = parsed.positional[0];
        if (!symbolName) {
          console.error("Usage: codeindex xref <symbol> [--format json|table]");
          process.exit(1);
        }
        const xrefFormat = flag(parsed, "format") ?? "table";
        const xrefResult = await xrefSymbol(repoRoot, symbolName);
        if (xrefFormat === "json") {
          console.log(formatXrefJson(xrefResult));
        } else {
          console.log(formatXrefTable(xrefResult));
        }
        break;
      }

      case "mcp-config":
        await cmdMcpConfig(parsed);
        break;

      case "serve": {
        const { createMcpServer } = await import("./mcp/server");
        const { startStdio, startSSE } = await import("./mcp/transport");
        const transport = flag(parsed, "transport") ?? "stdio";
        if (transport === "sse") {
          const portStr = flag(parsed, "port");
          await startSSE(
            (session) => createMcpServer(repoRoot, session),
            portStr ? parseInt(portStr) : 3100,
            repoRoot,
          );
        } else {
          const { authenticateSession } = await import("./mcp/auth");
          const token = process.env.CODEINDEX_TOKEN;
          const session = await authenticateSession(repoRoot, token);
          if (session === null) {
            console.error("Authentication failed: invalid or missing token.");
            process.exit(1);
          }
          const mcpServer = createMcpServer(repoRoot, session);
          await startStdio(mcpServer);
        }
        break;
      }

      case "":
      case "help":
      case "--help":
      case "-h":
        console.log(HELP_TEXT);
        break;

      default:
        console.error(`Unknown command: '${parsed.command}'. Run 'codeindex' for usage.`);
        process.exit(1);
    }
  } finally {
    await closePg();
    await closeSqlite();
  }
}

main().catch((err) => {
  console.error(formatError(err));
  process.exit(1);
});
