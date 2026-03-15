import { getPg, pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { serializeEmbedding } from "../db/util";
import { embedSingle } from "../index/embedder";
import { getFileCommits } from "../index/commits";
import type { PipelineContext, IndexCommitsStage } from "./types";

type CommitRecord = {
  relPath: string;
  hash: string;
  message: string;
  date: string;
  rank: number;
  embedding: number[] | null;
};

/**
 * Walk git log for all files, embed new commit messages, and upsert
 * commit records and file_commits links into the DB.
 * Returns the count of newly embedded commits.
 */
export const indexCommits: IndexCommitsStage = async (
  ctx: PipelineContext,
  allFiles: string[],
): Promise<number> => {
  const { repoRoot, repoId, config, store } = ctx;
  let commitCount = 0;

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
          store === "pg"
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

  if (commitRecords.length === 0) return 0;

  if (store === "pg") {
    const pg = await getPg();
    await pg.begin(async (tx) => {
      for (const cr of commitRecords) {
        let commitId: number;
        if (cr.embedding) {
          const inserted = (await tx.unsafe(
            `INSERT INTO commits (repo_id, commit_hash, message, embedding, authored_at)
             VALUES ($1, $2, $3, $4::vector, $5)
             ON CONFLICT (repo_id, commit_hash) DO UPDATE SET
               message = EXCLUDED.message,
               embedding = EXCLUDED.embedding
             RETURNING id`,
            [repoId, cr.hash, cr.message, `[${cr.embedding.join(",")}]`, cr.date],
          )) as { id: number }[];
          commitId = inserted[0].id;
          commitCount++;
        } else {
          const existing = (await tx.unsafe(
            "SELECT id FROM commits WHERE repo_id = $1 AND commit_hash = $2",
            [repoId, cr.hash],
          )) as { id: number }[];
          commitId = existing[0].id;
        }

        const fileRows = (await tx.unsafe(
          "SELECT id FROM files WHERE repo_id = $1 AND file_path = $2",
          [repoId, cr.relPath],
        )) as { id: number }[];
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
    const selectCommit = db.prepare("SELECT id FROM commits WHERE repo_id = ? AND commit_hash = ?");
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

  return commitCount;
};
