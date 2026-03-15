import fs from "fs/promises";
import path from "path";
import { loadConfig } from "../config";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";
import { logEvent } from "../logging";

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
  const start = performance.now();
  const config = await loadConfig(repoRoot);

  const edges = config.store === "pg" ? await discoverPg() : await discoverSqlite(repoRoot);

  logEvent({
    event: "index.discovery.cross_repo.complete",
    edges_discovered: edges.length,
    duration_ms: Math.round(performance.now() - start),
  });

  return edges;
}

async function discoverPg(): Promise<CrossRepoEdge[]> {
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

  if (unresolved.length === 0) return [];

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

  // Load package.json names for TS/JS bare specifier matching
  const repos = (await pgUnsafe(`SELECT id, root_path FROM repos`)) as {
    id: string;
    root_path: string;
  }[];
  const packageNames = await loadPackageNames(
    repos.map((r) => ({ id: parseInt(r.id), rootPath: r.root_path })),
  );

  // Wrap DELETE + INSERT in a transaction for atomicity
  await pgUnsafe("BEGIN");
  try {
    // Scope delete to repos with unresolved imports, not full-table wipe
    const sourceRepoIds = [...new Set(unresolved.map((u) => parseInt(u.source_repo_id)))];
    for (const repoId of sourceRepoIds) {
      await pgUnsafe("DELETE FROM cross_repo_edges WHERE source_repo_id = $1", [repoId]);
    }

    const edges: CrossRepoEdge[] = [];

    for (const imp of unresolved) {
      const sourceRepoId = parseInt(imp.source_repo_id);
      const match = tryResolveAcrossRepos(
        imp.imported_module,
        imp.language,
        imp.source_file_path,
        sourceRepoId,
        filesByRepo,
        packageNames,
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

    await pgUnsafe("COMMIT");
    return edges;
  } catch (err) {
    await pgUnsafe("ROLLBACK");
    logEvent({
      event: "index.discovery.cross_repo.error",
      "error.type": "transaction_rollback",
      "error.message": err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function discoverSqlite(repoRoot: string): Promise<CrossRepoEdge[]> {
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

  if (unresolved.length === 0) return [];

  const allFiles = db
    .prepare(`SELECT f.id AS file_id, f.repo_id, f.file_path FROM files f`)
    .all() as { file_id: number; repo_id: number; file_path: string }[];

  const filesByRepo = new Map<number, RepoFile[]>();
  for (const f of allFiles) {
    const list = filesByRepo.get(f.repo_id) ?? [];
    list.push({ fileId: f.file_id, repoId: f.repo_id, filePath: f.file_path });
    filesByRepo.set(f.repo_id, list);
  }

  // Load package.json names for TS/JS bare specifier matching
  const repos = db.prepare(`SELECT id, root_path FROM repos`).all() as {
    id: number;
    root_path: string;
  }[];
  const packageNames = await loadPackageNames(
    repos.map((r) => ({ id: r.id, rootPath: r.root_path })),
  );

  const insert = db.prepare(
    `INSERT OR IGNORE INTO cross_repo_edges (source_repo_id, target_repo_id, source_file_id, imported_module, target_file_id, language)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  // Wrap DELETE + INSERT in a transaction for atomicity
  const edges: CrossRepoEdge[] = [];
  const replaceEdges = db.transaction(() => {
    // Scope delete to repos with unresolved imports, not full-table wipe
    const sourceRepoIds = [...new Set(unresolved.map((u) => u.source_repo_id))];
    const delStmt = db.prepare("DELETE FROM cross_repo_edges WHERE source_repo_id = ?");
    for (const repoId of sourceRepoIds) {
      delStmt.run(repoId);
    }

    for (const imp of unresolved) {
      const match = tryResolveAcrossRepos(
        imp.imported_module,
        imp.language,
        imp.source_file_path,
        imp.source_repo_id,
        filesByRepo,
        packageNames,
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
  });
  replaceEdges();
  return edges;
}

/**
 * Load the package.json "name" field for each repo, keyed by repo ID.
 * Returns a new Map built from resolved entries (no shared mutation).
 */
async function loadPackageNames(
  repos: { id: number; rootPath: string }[],
): Promise<Map<number, string>> {
  const entries = await Promise.all(
    repos.map(async (repo): Promise<[number, string] | null> => {
      try {
        const raw = await fs.readFile(path.join(repo.rootPath, "package.json"), "utf-8");
        const pkg = JSON.parse(raw);
        return typeof pkg.name === "string" && pkg.name.length > 0 ? [repo.id, pkg.name] : null;
      } catch {
        // No package.json or unreadable — skip
        return null;
      }
    }),
  );
  return new Map(entries.filter((e): e is [number, string] => e !== null));
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
  packageNames: Map<number, string>,
): RepoFile | null {
  for (const [repoId, files] of filesByRepo) {
    if (repoId === sourceRepoId) continue;

    if (language === "typescript" || language === "javascript") {
      const match = resolveTsAcrossRepo(importedModule, files, packageNames.get(repoId));
      if (match) return match;
    } else if (language === "python") {
      const match = resolvePythonAcrossRepo(importedModule, files);
      if (match) return match;
    }
  }
  return null;
}

function resolveTsAcrossRepo(
  module: string,
  files: RepoFile[],
  packageName?: string,
): RepoFile | null {
  // Skip relative imports — those are intra-repo
  if (module.startsWith(".") || module.startsWith("/")) return null;

  // Match bare specifier against package.json name.
  // e.g., import { foo } from "my-utils" matches repo with package.json name "my-utils"
  // Also handles scoped subpath: "my-utils/sub" where root segment matches the package name
  if (packageName) {
    const rootSegment = module.includes("/") ? module.split("/")[0] : module;
    // Handle scoped packages: "@scope/pkg" → compare full scoped name
    const specifierRoot = module.startsWith("@")
      ? module.split("/").slice(0, 2).join("/")
      : rootSegment;
    const subpath = module.startsWith("@")
      ? module.split("/").slice(2).join("/")
      : module.includes("/")
        ? module.split("/").slice(1).join("/")
        : null;

    if (specifierRoot === packageName) {
      // Exact package match — resolve to entry point or subpath
      if (subpath) {
        return resolveSubpath(subpath, files);
      }
      // Look for index/main entry point
      return resolveEntryPoint(files);
    }
  }

  // Fall back to file-path heuristics
  const extensions = [".ts", ".tsx", ".js", ".jsx"];

  for (const file of files) {
    const basename = path.basename(file.filePath, path.extname(file.filePath));
    const dirname = path.dirname(file.filePath);

    if (basename === module && (dirname === "." || dirname === "src")) {
      return file;
    }

    for (const ext of extensions) {
      if (file.filePath === `${module}${ext}` || file.filePath === `src/${module}${ext}`) {
        return file;
      }
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

function resolveSubpath(subpath: string, files: RepoFile[]): RepoFile | null {
  const extensions = [".ts", ".tsx", ".js", ".jsx"];
  for (const ext of extensions) {
    for (const file of files) {
      if (
        file.filePath === `${subpath}${ext}` ||
        file.filePath === `src/${subpath}${ext}` ||
        file.filePath === `${subpath}/index${ext}` ||
        file.filePath === `src/${subpath}/index${ext}`
      ) {
        return file;
      }
    }
  }
  return null;
}

function resolveEntryPoint(files: RepoFile[]): RepoFile | null {
  const extensions = [".ts", ".tsx", ".js", ".jsx"];
  for (const ext of extensions) {
    for (const file of files) {
      if (file.filePath === `index${ext}` || file.filePath === `src/index${ext}`) {
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
