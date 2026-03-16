import path from "path";
import { loadConfig } from "../config";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { getRepoIdByPath } from "../db/repo-lookup";
import { walkRepo } from "../index/walker";
import { scanForSecrets } from "../index/secrets";

export async function cmdManifest(repoRoot: string) {
  const config = await loadConfig(repoRoot);

  // --- Indexed data from DB ---
  const repoId = await getRepoIdByPath(repoRoot);
  const dbStats = await (async () => {
    if (repoId === null) return null;
    if (config.store === "pg") {
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

  // --- Walk repo to collect all non-indexed file paths (I/O boundary) ---
  const indexedSet = new Set(filePaths);
  const walkedFiles: { relPath: string; content: string | null }[] = [];
  for await (const relPath of walkRepo(repoRoot)) {
    if (indexedSet.has(relPath)) continue;
    const absPath = path.join(repoRoot, relPath);
    let content: string | null = null;
    try {
      content = (await Bun.file(absPath).text()).replace(/\0/g, "");
    } catch {
      // File unreadable
    }
    walkedFiles.push({ relPath, content });
  }

  // --- Pure transform: classify each walked file into skipped/secret ---
  const classified = walkedFiles.map(({ relPath, content }) => {
    if (content !== null) {
      const scan = scanForSecrets(content);
      if (scan.hasSecrets) {
        return {
          skipped: { path: relPath, reason: `secrets: ${scan.patterns.join(", ")}` },
          secret: { path: relPath, patterns: scan.patterns },
        };
      }
    }
    return {
      skipped: { path: relPath, reason: "not indexed (unchanged or new)" },
      secret: null,
    };
  });

  const skippedFiles = classified.map((c) => c.skipped);
  const secretFlags = classified.filter((c) => c.secret !== null).map((c) => c.secret!);

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
