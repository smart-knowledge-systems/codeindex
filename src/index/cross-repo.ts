import path from "path";
import { loadConfig } from "../config";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";

export interface CrossRepoEdge {
  sourceRepoId: number;
  targetRepoId: number;
  sourceFileId: number;
  importedModule: string;
  targetFileId: number | null;
  language: string;
}

interface RepoFile {
  fileId: number;
  repoId: number;
  filePath: string;
}

/**
 * Discover cross-repo import relationships by attempting to resolve
 * unresolved imports (resolved_file_id IS NULL) against files in other repos.
 *
 * Supports:
 * - TS/JS: bare specifiers matched against package.json names in other repos
 * - Python: dotted imports matched against file paths in other repos
 */
export async function discoverCrossRepoEdges(repoRoot: string): Promise<CrossRepoEdge[]> {
  const config = await loadConfig(repoRoot);
  const edges: CrossRepoEdge[] = [];

  if (config.store === "pg") {
    await discoverPg(edges);
  } else {
    await discoverSqlite(repoRoot, edges);
  }

  return edges;
}

async function discoverPg(edges: CrossRepoEdge[]): Promise<void> {
  // Get all unresolved imports
  const unresolved = (await pgUnsafe(
    `SELECT fi.id, fi.source_file_id, f.repo_id AS source_repo_id,
            fi.imported_module, fi.language, f.file_path AS source_file_path
     FROM file_imports fi
     JOIN files f ON f.id = fi.source_file_id
     WHERE fi.resolved_file_id IS NULL`,
  )) as {
    id: string;
    source_file_id: string;
    source_repo_id: string;
    imported_module: string;
    language: string;
    source_file_path: string;
  }[];

  if (unresolved.length === 0) return;

  // Get all files from all repos for cross-repo resolution
  const allFiles = (await pgUnsafe(
    `SELECT f.id AS file_id, f.repo_id, f.file_path FROM files f`,
  )) as { file_id: string; repo_id: string; file_path: string }[];

  // Group files by repo for efficient lookup
  const filesByRepo = new Map<number, RepoFile[]>();
  for (const f of allFiles) {
    const repoId = parseInt(f.repo_id);
    const list = filesByRepo.get(repoId) ?? [];
    list.push({ fileId: parseInt(f.file_id), repoId, filePath: f.file_path });
    filesByRepo.set(repoId, list);
  }

  // Clear existing cross-repo edges
  await pgUnsafe("DELETE FROM cross_repo_edges");

  for (const imp of unresolved) {
    const sourceRepoId = parseInt(imp.source_repo_id);
    const match = tryResolveAcrossRepos(
      imp.imported_module,
      imp.language,
      imp.source_file_path,
      sourceRepoId,
      filesByRepo,
    );

    if (match) {
      const edge: CrossRepoEdge = {
        sourceRepoId,
        targetRepoId: match.repoId,
        sourceFileId: parseInt(imp.source_file_id),
        importedModule: imp.imported_module,
        targetFileId: match.fileId,
        language: imp.language,
      };
      edges.push(edge);

      await pgUnsafe(
        `INSERT INTO cross_repo_edges (source_repo_id, target_repo_id, source_file_id, imported_module, target_file_id, language)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (source_file_id, imported_module) DO UPDATE SET
           target_repo_id = EXCLUDED.target_repo_id,
           target_file_id = EXCLUDED.target_file_id`,
        [
          edge.sourceRepoId,
          edge.targetRepoId,
          edge.sourceFileId,
          edge.importedModule,
          edge.targetFileId,
          edge.language,
        ],
      );
    }
  }
}

async function discoverSqlite(repoRoot: string, edges: CrossRepoEdge[]): Promise<void> {
  const db = await getSqlite(repoRoot);

  const unresolved = db
    .prepare(
      `SELECT fi.id, fi.source_file_id, f.repo_id AS source_repo_id,
              fi.imported_module, fi.language, f.file_path AS source_file_path
       FROM file_imports fi
       JOIN files f ON f.id = fi.source_file_id
       WHERE fi.resolved_file_id IS NULL`,
    )
    .all() as {
    id: number;
    source_file_id: number;
    source_repo_id: number;
    imported_module: string;
    language: string;
    source_file_path: string;
  }[];

  if (unresolved.length === 0) return;

  const allFiles = db
    .prepare(`SELECT f.id AS file_id, f.repo_id, f.file_path FROM files f`)
    .all() as { file_id: number; repo_id: number; file_path: string }[];

  const filesByRepo = new Map<number, RepoFile[]>();
  for (const f of allFiles) {
    const list = filesByRepo.get(f.repo_id) ?? [];
    list.push({ fileId: f.file_id, repoId: f.repo_id, filePath: f.file_path });
    filesByRepo.set(f.repo_id, list);
  }

  db.prepare("DELETE FROM cross_repo_edges").run();

  const insert = db.prepare(
    `INSERT INTO cross_repo_edges (source_repo_id, target_repo_id, source_file_id, imported_module, target_file_id, language)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const imp of unresolved) {
    const match = tryResolveAcrossRepos(
      imp.imported_module,
      imp.language,
      imp.source_file_path,
      imp.source_repo_id,
      filesByRepo,
    );

    if (match) {
      const edge: CrossRepoEdge = {
        sourceRepoId: imp.source_repo_id,
        targetRepoId: match.repoId,
        sourceFileId: imp.source_file_id,
        importedModule: imp.imported_module,
        targetFileId: match.fileId,
        language: imp.language,
      };
      edges.push(edge);
      insert.run(
        edge.sourceRepoId,
        edge.targetRepoId,
        edge.sourceFileId,
        edge.importedModule,
        edge.targetFileId,
        edge.language,
      );
    }
  }
}

/**
 * Try to resolve an import against files in other repos.
 */
function tryResolveAcrossRepos(
  importedModule: string,
  language: string,
  sourceFilePath: string,
  sourceRepoId: number,
  filesByRepo: Map<number, RepoFile[]>,
): RepoFile | null {
  for (const [repoId, files] of filesByRepo) {
    if (repoId === sourceRepoId) continue;

    if (language === "typescript" || language === "javascript") {
      const match = resolveTsAcrossRepo(importedModule, files);
      if (match) return match;
    } else if (language === "python") {
      const match = resolvePythonAcrossRepo(importedModule, files);
      if (match) return match;
    }
  }
  return null;
}

function resolveTsAcrossRepo(module: string, files: RepoFile[]): RepoFile | null {
  // Skip relative imports — those are intra-repo
  if (module.startsWith(".") || module.startsWith("/")) return null;

  // Try matching against file paths that look like the module
  // e.g., "lodash/merge" → find "src/merge.ts" in a repo named "lodash"
  const extensions = [".ts", ".tsx", ".js", ".jsx"];

  // Check if any file matches module/index or module directly
  for (const file of files) {
    const basename = path.basename(file.filePath, path.extname(file.filePath));
    const dirname = path.dirname(file.filePath);

    // Direct match: module === basename at root level
    if (basename === module && (dirname === "." || dirname === "src")) {
      return file;
    }

    // Module path match: "module/sub" → "src/sub.ts" etc.
    for (const ext of extensions) {
      if (file.filePath === `${module}${ext}` || file.filePath === `src/${module}${ext}`) {
        return file;
      }
      // Index file match
      if (
        file.filePath === `${module}/index${ext}` ||
        file.filePath === `src/${module}/index${ext}`
      ) {
        return file;
      }
    }
  }

  return null;
}

function resolvePythonAcrossRepo(module: string, files: RepoFile[]): RepoFile | null {
  const filePath = module.replace(/\./g, "/");

  for (const file of files) {
    if (file.filePath === `${filePath}.py` || file.filePath === `${filePath}/__init__.py`) {
      return file;
    }
    // Also check under src/
    if (file.filePath === `src/${filePath}.py` || file.filePath === `src/${filePath}/__init__.py`) {
      return file;
    }
  }

  return null;
}
