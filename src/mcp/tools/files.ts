import { z } from "zod";
import { loadConfig } from "../../config";
import { getSqlite } from "../../db/sqlite";
import { validateRepoScope } from "../auth";
import { recordEvent } from "../../telemetry";
import { getSessionId } from "../../logging";
import type { McpToolContext } from "../helpers";
import { mcpSuccess, mcpError, withMcpScope, escapeLike, ACCESS_DENIED_MSG } from "../helpers";

export function registerFileTools(ctx: McpToolContext): void {
  const { mcp, defaultRepoRoot, session } = ctx;

  // --- getImporters tool ---
  mcp.tool(
    "getImporters",
    "Find all files that import a given file. Returns importer file paths with import specifiers.",
    {
      filePath: z.string().describe("Relative file path to find importers of"),
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ filePath, repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "getImporters",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError(ACCESS_DENIED_MSG);
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);

      if (config.store === "pg") {
        const rows = await withMcpScope(session, async (tx) =>
          tx.unsafe(
            `SELECT sf.file_path AS importer, fi.imported_module
           FROM file_imports fi
           JOIN files tf ON tf.id = fi.resolved_file_id
           JOIN files sf ON sf.id = fi.source_file_id
           JOIN repos r ON r.id = tf.repo_id
           WHERE r.root_path = $1 AND tf.file_path = $2`,
            [repoRoot, filePath],
          ),
        );
        return mcpSuccess(rows);
      } else {
        const db = await getSqlite(repoRoot);
        const rows = db
          .prepare(
            `SELECT sf.file_path AS importer, fi.imported_module
             FROM file_imports fi
             JOIN files tf ON tf.id = fi.resolved_file_id
             JOIN files sf ON sf.id = fi.source_file_id
             JOIN repos r ON r.id = tf.repo_id
             WHERE r.root_path = ? AND tf.file_path = ?`,
          )
          .all(repoRoot, filePath);
        return mcpSuccess(rows);
      }
    },
  );

  // --- getDependencies tool ---
  mcp.tool(
    "getDependencies",
    "Find all files that a given file imports/depends on.",
    {
      filePath: z.string().describe("Relative file path to find dependencies of"),
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ filePath, repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "getDependencies",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError(ACCESS_DENIED_MSG);
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);

      if (config.store === "pg") {
        const rows = await withMcpScope(session, async (tx) =>
          tx.unsafe(
            `SELECT tf.file_path AS dependency, fi.imported_module
           FROM file_imports fi
           JOIN files sf ON sf.id = fi.source_file_id
           LEFT JOIN files tf ON tf.id = fi.resolved_file_id
           JOIN repos r ON r.id = sf.repo_id
           WHERE r.root_path = $1 AND sf.file_path = $2`,
            [repoRoot, filePath],
          ),
        );
        return mcpSuccess(rows);
      } else {
        const db = await getSqlite(repoRoot);
        const rows = db
          .prepare(
            `SELECT tf.file_path AS dependency, fi.imported_module
             FROM file_imports fi
             JOIN files sf ON sf.id = fi.source_file_id
             LEFT JOIN files tf ON tf.id = fi.resolved_file_id
             JOIN repos r ON r.id = sf.repo_id
             WHERE r.root_path = ? AND sf.file_path = ?`,
          )
          .all(repoRoot, filePath);
        return mcpSuccess(rows);
      }
    },
  );

  // --- traceImportChain tool ---
  mcp.tool(
    "traceImportChain",
    "Trace the full import chain from a file, following dependencies recursively up to a max depth.",
    {
      filePath: z.string().describe("Starting file path"),
      direction: z
        .enum(["importers", "dependencies"])
        .optional()
        .describe("Direction to trace (default: dependencies)"),
      maxDepth: z.number().optional().describe("Maximum recursion depth (default: 10, max: 10)"),
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ filePath, direction, maxDepth, repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "traceImportChain",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError(ACCESS_DENIED_MSG);
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);
      const depth = Math.min(maxDepth ?? 10, 10);
      const dir = direction ?? "dependencies";

      const scopedRepoIds = session?.repoIds ?? null;

      if (config.store === "pg") {
        const repoFilter = scopedRepoIds ? `AND nf.repo_id = ANY($4::int[])` : "";
        const params: unknown[] = [repoRoot, filePath, depth];
        if (scopedRepoIds) params.push(scopedRepoIds);
        const query =
          dir === "dependencies"
            ? `WITH RECURSIVE chain AS (
                 SELECT f.id, f.file_path, 0 AS depth
                 FROM files f JOIN repos r ON r.id = f.repo_id
                 WHERE r.root_path = $1 AND f.file_path = $2
               UNION ALL
                 SELECT nf.id, nf.file_path, c.depth + 1
                 FROM chain c
                 JOIN file_imports fi ON fi.source_file_id = c.id
                 JOIN files nf ON nf.id = fi.resolved_file_id
                 WHERE c.depth < $3 ${repoFilter}
               )
               SELECT DISTINCT file_path, depth FROM chain ORDER BY depth`
            : `WITH RECURSIVE chain AS (
                 SELECT f.id, f.file_path, 0 AS depth
                 FROM files f JOIN repos r ON r.id = f.repo_id
                 WHERE r.root_path = $1 AND f.file_path = $2
               UNION ALL
                 SELECT nf.id, nf.file_path, c.depth + 1
                 FROM chain c
                 JOIN file_imports fi ON fi.resolved_file_id = c.id
                 JOIN files nf ON nf.id = fi.source_file_id
                 WHERE c.depth < $3 ${repoFilter}
               )
               SELECT DISTINCT file_path, depth FROM chain ORDER BY depth`;
        const rows = await withMcpScope(session, async (tx) => tx.unsafe(query, params));
        return mcpSuccess(rows);
      } else {
        // SQLite: iterative BFS since recursive CTEs with dynamic column names are awkward
        const db = await getSqlite(repoRoot);
        const startRow = db
          .prepare(
            `SELECT f.id FROM files f JOIN repos r ON r.id = f.repo_id
             WHERE r.root_path = ? AND f.file_path = ?`,
          )
          .get(repoRoot, filePath) as { id: number } | null;
        if (!startRow) return mcpSuccess([]);

        // Build scope filter for SQLite
        const scopedFileIds = scopedRepoIds
          ? new Set(
              (
                db
                  .prepare(
                    `SELECT id FROM files WHERE repo_id IN (${scopedRepoIds.map(() => "?").join(",")})`,
                  )
                  .all(...scopedRepoIds) as { id: number }[]
              ).map((r) => r.id),
            )
          : null;

        const filePathStmt = db.prepare(`SELECT file_path FROM files WHERE id = ?`);
        const importStmt =
          dir === "dependencies"
            ? db.prepare(
                `SELECT resolved_file_id AS next_id FROM file_imports WHERE source_file_id = ? AND resolved_file_id IS NOT NULL`,
              )
            : db.prepare(
                `SELECT source_file_id AS next_id FROM file_imports WHERE resolved_file_id = ?`,
              );

        const startFilePath = (filePathStmt.get(startRow.id) as { file_path: string }).file_path;

        // BFS traversal using imperative loop
        const visited = new Map<number, { file_path: string; depth: number }>();
        visited.set(startRow.id, { file_path: startFilePath, depth: 0 });
        let frontier = [startRow.id];
        let currentDepth = 0;

        while (frontier.length > 0 && currentDepth < depth) {
          const nextDepth = currentDepth + 1;
          const nextFrontier: number[] = [];
          for (const id of frontier) {
            const nexts = importStmt.all(id) as { next_id: number }[];
            for (const n of nexts) {
              if (visited.has(n.next_id)) continue;
              if (scopedFileIds && !scopedFileIds.has(n.next_id)) continue;
              const fp = (filePathStmt.get(n.next_id) as { file_path: string }).file_path;
              visited.set(n.next_id, { file_path: fp, depth: nextDepth });
              nextFrontier.push(n.next_id);
            }
          }
          frontier = nextFrontier;
          currentDepth = nextDepth;
        }

        const results = [...visited.values()].sort((a, b) => a.depth - b.depth);
        return mcpSuccess(results);
      }
    },
  );

  // --- getCrossRepoEdges tool ---
  mcp.tool(
    "getCrossRepoEdges",
    "Get cross-repository dependency edges, showing how repos depend on each other.",
    {
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "getCrossRepoEdges",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError(ACCESS_DENIED_MSG);
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);
      const scopedRepoIds = session?.repoIds ?? null;

      if (config.store === "pg") {
        const query = scopedRepoIds
          ? `SELECT sr.name AS source_repo, tr.name AS target_repo,
                    sf.file_path AS source_file, tf.file_path AS target_file,
                    e.imported_module
             FROM cross_repo_edges e
             JOIN repos sr ON sr.id = e.source_repo_id
             JOIN repos tr ON tr.id = e.target_repo_id
             JOIN files sf ON sf.id = e.source_file_id
             JOIN files tf ON tf.id = e.target_file_id
             WHERE (e.source_repo_id = ANY($1::int[]) OR e.target_repo_id = ANY($1::int[]))
             ORDER BY sr.name, tr.name`
          : `SELECT sr.name AS source_repo, tr.name AS target_repo,
                    sf.file_path AS source_file, tf.file_path AS target_file,
                    e.imported_module
             FROM cross_repo_edges e
             JOIN repos sr ON sr.id = e.source_repo_id
             JOIN repos tr ON tr.id = e.target_repo_id
             JOIN files sf ON sf.id = e.source_file_id
             JOIN files tf ON tf.id = e.target_file_id
             ORDER BY sr.name, tr.name`;
        const params = scopedRepoIds ? [scopedRepoIds] : [];
        const rows = await withMcpScope(session, async (tx) => tx.unsafe(query, params));
        return mcpSuccess(rows);
      } else {
        const db = await getSqlite(repoRoot);
        if (scopedRepoIds && scopedRepoIds.length > 0) {
          const placeholders = scopedRepoIds.map(() => "?").join(",");
          const rows = db
            .prepare(
              `SELECT sr.name AS source_repo, tr.name AS target_repo,
                      sf.file_path AS source_file, tf.file_path AS target_file,
                      e.imported_module
               FROM cross_repo_edges e
               JOIN repos sr ON sr.id = e.source_repo_id
               JOIN repos tr ON tr.id = e.target_repo_id
               JOIN files sf ON sf.id = e.source_file_id
               JOIN files tf ON tf.id = e.target_file_id
               WHERE (e.source_repo_id IN (${placeholders}) OR e.target_repo_id IN (${placeholders}))
               ORDER BY sr.name, tr.name`,
            )
            .all(...scopedRepoIds, ...scopedRepoIds);
          return mcpSuccess(rows);
        } else {
          const rows = db
            .prepare(
              `SELECT sr.name AS source_repo, tr.name AS target_repo,
                      sf.file_path AS source_file, tf.file_path AS target_file,
                      e.imported_module
               FROM cross_repo_edges e
               JOIN repos sr ON sr.id = e.source_repo_id
               JOIN repos tr ON tr.id = e.target_repo_id
               JOIN files sf ON sf.id = e.source_file_id
               JOIN files tf ON tf.id = e.target_file_id
               ORDER BY sr.name, tr.name`,
            )
            .all();
          return mcpSuccess(rows);
        }
      }
    },
  );

  // --- findImplementors tool ---
  mcp.tool(
    "findImplementors",
    "Find files that implement or extend a given interface/class/trait by searching skeleton entries.",
    {
      symbol: z.string().describe("Interface, class, or trait name to find implementors of"),
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ symbol, repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "findImplementors",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError(ACCESS_DENIED_MSG);
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);
      const pattern = `%${escapeLike(symbol)}%`;
      const scopedRepoIds = session?.repoIds ?? null;

      if (config.store === "pg") {
        const query = scopedRepoIds
          ? `SELECT f.file_path, f.skeleton_entries, r.name AS repo_name
             FROM files f
             JOIN repos r ON r.id = f.repo_id
             WHERE f.skeleton LIKE $1 ESCAPE '\\'
               AND (f.skeleton LIKE '%implements%' OR f.skeleton LIKE '%extends%'
                    OR f.skeleton LIKE '%: %' OR f.skeleton LIKE '%conform%')
               AND r.id = ANY($2::int[])
             LIMIT 100`
          : `SELECT f.file_path, f.skeleton_entries, r.name AS repo_name
             FROM files f
             JOIN repos r ON r.id = f.repo_id
             WHERE f.skeleton LIKE $1 ESCAPE '\\'
               AND (f.skeleton LIKE '%implements%' OR f.skeleton LIKE '%extends%'
                    OR f.skeleton LIKE '%: %' OR f.skeleton LIKE '%conform%')
             LIMIT 100`;
        const params = scopedRepoIds ? [pattern, scopedRepoIds] : [pattern];
        const rows = await withMcpScope(session, async (tx) => tx.unsafe(query, params));
        return mcpSuccess(rows);
      } else {
        const db = await getSqlite(repoRoot);
        const scopeFilter =
          scopedRepoIds && scopedRepoIds.length > 0
            ? `AND r.id IN (${scopedRepoIds.map(() => "?").join(",")})`
            : "";
        const scopeParams = scopedRepoIds && scopedRepoIds.length > 0 ? scopedRepoIds : [];
        const rows = db
          .prepare(
            `SELECT f.file_path, f.skeleton_entries, r.name AS repo_name
             FROM files f
             JOIN repos r ON r.id = f.repo_id
             WHERE f.skeleton LIKE ? ESCAPE '\\'
               AND (f.skeleton LIKE '%implements%' OR f.skeleton LIKE '%extends%'
                    OR f.skeleton LIKE '%: %' OR f.skeleton LIKE '%conform%')
               ${scopeFilter}
             LIMIT 100`,
          )
          .all(pattern, ...scopeParams);
        return mcpSuccess(rows);
      }
    },
  );

  // --- findCallers tool ---
  mcp.tool(
    "findCallers",
    "Find files that import and potentially call a given symbol by searching import specifiers and skeletons.",
    {
      symbol: z.string().describe("Function, class, or symbol name to find callers of"),
      repoPath: z.string().optional().describe("Repository root path (defaults to server root)"),
    },
    async ({ symbol, repoPath }) => {
      recordEvent({
        event: "mcp_tool",
        timestamp: new Date().toISOString(),
        tool: "findCallers",
        sessionId: getSessionId(),
      });
      if (session) {
        const allowed = await validateRepoScope(defaultRepoRoot, repoPath, session);
        if (!allowed) return mcpError(ACCESS_DENIED_MSG);
      }
      const repoRoot = repoPath ?? defaultRepoRoot;
      const config = await loadConfig(repoRoot);
      const pattern = `%${escapeLike(symbol)}%`;
      const scopedRepoIds = session?.repoIds ?? null;

      if (config.store === "pg") {
        const query = scopedRepoIds
          ? `SELECT DISTINCT sf.file_path, r.name AS repo_name, fi.imported_module
             FROM file_imports fi
             JOIN files sf ON sf.id = fi.source_file_id
             JOIN repos r ON r.id = sf.repo_id
             WHERE fi.imported_module LIKE $1 ESCAPE '\\'
               AND r.id = ANY($2::int[])
             ORDER BY r.name, sf.file_path
             LIMIT 100`
          : `SELECT DISTINCT sf.file_path, r.name AS repo_name, fi.imported_module
             FROM file_imports fi
             JOIN files sf ON sf.id = fi.source_file_id
             JOIN repos r ON r.id = sf.repo_id
             WHERE fi.imported_module LIKE $1 ESCAPE '\\'
             ORDER BY r.name, sf.file_path
             LIMIT 100`;
        const params = scopedRepoIds ? [pattern, scopedRepoIds] : [pattern];
        const rows = await withMcpScope(session, async (tx) => tx.unsafe(query, params));
        return mcpSuccess(rows);
      } else {
        const db = await getSqlite(repoRoot);
        const scopeFilter =
          scopedRepoIds && scopedRepoIds.length > 0
            ? `AND r.id IN (${scopedRepoIds.map(() => "?").join(",")})`
            : "";
        const scopeParams = scopedRepoIds && scopedRepoIds.length > 0 ? scopedRepoIds : [];
        const rows = db
          .prepare(
            `SELECT DISTINCT sf.file_path, r.name AS repo_name, fi.imported_module
             FROM file_imports fi
             JOIN files sf ON sf.id = fi.source_file_id
             JOIN repos r ON r.id = sf.repo_id
             WHERE fi.imported_module LIKE ? ESCAPE '\\'
               ${scopeFilter}
             ORDER BY r.name, sf.file_path
             LIMIT 100`,
          )
          .all(pattern, ...scopeParams);
        return mcpSuccess(rows);
      }
    },
  );
}
