import path from "path";
import { loadConfig, detectFormatter } from "../config";
import { getPg, pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { serializeEmbedding } from "../db/util";
import { getChangedFiles } from "../index/commits";
import { updateAffectedDirectories } from "../index/directories";
import { initParser } from "../index/skeleton";
import { checkRepoVisibility } from "../index/public-repo";
import { embedSingle } from "../index/embedder";
import { setCurrentRepo } from "../cost";
import { setCorrelationContext } from "../logging";
import { ensureRepo, collectChangedFiles, getCommitMessage } from "./helpers";
import { embedFiles, storeFiles } from "../pipeline";
import type { PipelineContext } from "../pipeline";
import { ensureDedupBackend } from "../dedup/prompt";
import { getGlobalStore } from "../dedup/global-store";
import type { GlobalDedupStore } from "../dedup/global-store";
import { logEvent } from "../logging";
import { getProjectedCost } from "../cost";

export async function cmdUpdate(repoRoot: string, files: string[], commitHash?: string) {
  const config = await loadConfig(repoRoot);
  const repoId = await ensureRepo(repoRoot);
  setCurrentRepo(repoId, repoRoot, config.store);
  setCorrelationContext({ repoId });
  const formatter = config.formatter ?? (await detectFormatter(repoRoot));

  await initParser();

  const changedFiles = files.length > 0 ? files : await getChangedFiles(repoRoot, commitHash);

  // Pure decision: partition changed files into deleted vs existing
  const fileExistence = await Promise.all(
    changedFiles.map(async (relPath) => ({
      relPath,
      exists: await Bun.file(path.join(repoRoot, relPath)).exists(),
    })),
  );
  const deletedFiles = fileExistence.filter((f) => !f.exists).map((f) => f.relPath);
  const existingFiles = fileExistence.filter((f) => f.exists).map((f) => f.relPath);

  // Impure shell: execute deletions
  for (const relPath of deletedFiles) {
    if (config.store === "pg") {
      await pgUnsafe("DELETE FROM files WHERE repo_id = $1 AND file_path = $2", [repoId, relPath]);
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
  }

  if (existingFiles.length === 0 && !commitHash) {
    console.log("Updated 0 files.");
    return;
  }

  const repoVisibility = await checkRepoVisibility(repoRoot);

  const dedupChoice = await ensureDedupBackend(config);
  let globalStore: GlobalDedupStore | undefined;
  if (dedupChoice.enabled && dedupChoice.backend !== null) {
    if (config.dedup) {
      config.dedup.backend = dedupChoice.backend;
      config.dedup.enabled = true;
    }
    try {
      globalStore = await getGlobalStore(config);
    } catch (err) {
      process.stderr.write(
        `[dedup] failed to open global store (${err instanceof Error ? err.message : String(err)}); proceeding without dedup\n`,
      );
    }
  }

  const ctx: PipelineContext = {
    repoRoot,
    repoId,
    config,
    formatter,
    store: config.store,
    dryRun: false,
    force: false,
    repoVisibility,
    globalStore,
    dedupStats: { hits: 0, misses: 0 },
  };

  // Collect only the specified changed files (not a full repo walk)
  // We run collectFiles with force=false — it will dedup by hash internally
  // but we restrict to changedFiles by collecting them manually here.
  const collected = await collectChangedFiles(ctx, existingFiles);

  if (collected.length > 0) {
    const embedded = await embedFiles(ctx, collected);
    if (embedded.length > 0) {
      await storeFiles(ctx, embedded);
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

  console.log(`Updated ${collected.length} files.`);
  if (ctx.dedupStats && (ctx.dedupStats.hits > 0 || ctx.dedupStats.misses > 0)) {
    const { hits, misses } = ctx.dedupStats;
    const total = hits + misses;
    const pct = total > 0 ? ((hits / total) * 100).toFixed(1) : "0.0";
    const projected = getProjectedCost(hits, 0, config.embedding.model);
    console.log(
      `Dedup:  ${hits} hits / ${misses} misses (${pct}% hit rate, ~$${projected.embeddingCost.toFixed(4)} saved)`,
    );
    logEvent({
      event: "infra.dedup.summary",
      hits,
      misses,
      hit_rate: total > 0 ? hits / total : 0,
      embedding_cost_saved: projected.embeddingCost,
    });
  }
}
