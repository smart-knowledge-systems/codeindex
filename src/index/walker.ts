import path from "path";
import { realpath, readdir } from "fs/promises";
import { existsSync } from "fs";
import ignore from "ignore";
import { logEvent } from "../logging";
import { detectPackage, type DetectedPackage } from "../dedup/package-detect";

// ---------------------------------------------------------------------------
// Extension allowlist — only files we have real parsers for
// ---------------------------------------------------------------------------

/** Extensions with dedicated tree-sitter extractors or prose parsers. */
export const INDEXABLE_EXTENSIONS = new Set([
  // From EXT_TO_LANG (skeleton.ts)
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hxx",
  ".h",
  ".cs",
  ".kt",
  ".kts",
  ".swift",
  ".rb",
  ".php",
  ".lua",
  ".scala",
  ".sc",
  // Markdown
  ".md",
  ".mdx",
]);

/** Skip files larger than 512 KB to avoid memory bloat and wasted embeddings. */
export const MAX_FILE_SIZE = 524_288;

// Hard-coded — cannot be overridden by .gitignore or .indexignore
const HARD_IGNORED = [".git/", ".codeindex.db"];

// Soft defaults — overridable via `!` patterns in .indexignore
const DEFAULT_IGNORED = [
  "node_modules/",
  // Secrets / credentials
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "credentials.json",
  "service-account*.json",
  ".npmrc",
  ".pypirc",
  ".docker/config.json",
  ".aws/",
  ".ssh/",
  // Build artifacts
  "dist/",
  "build/",
  ".next/",
  "__pycache__/",
  "*.pyc",
  // Lock files (large, no semantic value)
  "bun.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
];

// ---------------------------------------------------------------------------
// Result type for explicit error handling
// ---------------------------------------------------------------------------

type LoadResult = { ok: true; lines: string[] } | { ok: false; error: Error };

async function loadIgnoreFile(filePath: string): Promise<LoadResult> {
  try {
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const text = await file.text();
      return { ok: true, lines: text.split("\n") };
    }
    return { ok: true, lines: [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

// ---------------------------------------------------------------------------
// Pure filtering logic — separated from I/O
// ---------------------------------------------------------------------------

type Ignore = ReturnType<typeof ignore>;

/** Check whether a path should be yielded based on ignore rules and extension. */
function isIndexable(entry: string, hardIg: Ignore, softIg: Ignore): boolean {
  if (hardIg.ignores(entry) || softIg.ignores(entry)) return false;
  const ext = path.extname(entry).toLowerCase();
  // Extensionless files (Dockerfile, Makefile, etc.) pass through
  if (ext && !INDEXABLE_EXTENSIONS.has(ext)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Repo walker — yields relative paths of indexable files
// ---------------------------------------------------------------------------

export async function* walkRepo(repoRoot: string): AsyncGenerator<string> {
  const hardIg = ignore();
  hardIg.add(HARD_IGNORED);

  // Soft defaults → .gitignore → .indexignore (later patterns override earlier)
  const softIg = ignore();
  softIg.add(DEFAULT_IGNORED);

  const gitResult = await loadIgnoreFile(path.join(repoRoot, ".gitignore"));
  if (gitResult.ok && gitResult.lines.length > 0) {
    softIg.add(gitResult.lines);
  } else if (!gitResult.ok) {
    logEvent({
      event: "index.walker.ignore_error",
      file: ".gitignore",
      "error.message": gitResult.error.message,
    });
  }

  const indexResult = await loadIgnoreFile(path.join(repoRoot, ".indexignore"));
  if (indexResult.ok && indexResult.lines.length > 0) {
    softIg.add(indexResult.lines);
  } else if (!indexResult.ok) {
    logEvent({
      event: "index.walker.ignore_error",
      file: ".indexignore",
      "error.message": indexResult.error.message,
    });
  }

  const glob = new Bun.Glob("**/*");

  for await (const entry of glob.scan({ cwd: repoRoot, onlyFiles: true, followSymlinks: false })) {
    if (isIndexable(entry, hardIg, softIg)) {
      yield entry;
    }
  }
}

// ---------------------------------------------------------------------------
// Dependency-mode descent — yields installed packages for the dedup pipeline
// ---------------------------------------------------------------------------

/**
 * Roots to probe inside a repo for installed-package directories. Each entry
 * is a relative path from the repo root; missing roots are silently skipped.
 *
 * Cargo and Go modcache live globally, not inside the repo, so they are
 * walked from the user's home directory by walkGlobalDependencyCaches() —
 * not implemented in Phase 1 because their cache layout already deduplicates
 * on disk.
 */
const REPO_DEP_ROOTS = ["node_modules", "vendor"];

/**
 * Walk a repo's installed-dependency trees and yield each detected package
 * exactly once (deduped by realpath, which handles pnpm's symlink store).
 *
 * Caller is responsible for tree-hashing each yielded package and consulting
 * the global dedup store.
 */
export async function* walkDependencies(repoRoot: string): AsyncGenerator<DetectedPackage> {
  const seen = new Set<string>();

  for (const rel of REPO_DEP_ROOTS) {
    const root = path.join(repoRoot, rel);
    if (!existsSync(root)) continue;
    yield* walkDepRoot(root, seen);
  }
}

async function* walkDepRoot(root: string, seen: Set<string>): AsyncGenerator<DetectedPackage> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const childPath = path.join(root, name);

    // npm scoped packages live one level deeper: node_modules/@scope/pkg
    if (name.startsWith("@")) {
      yield* walkDepRoot(childPath, seen);
      continue;
    }

    // Resolve realpath so pnpm's .pnpm/<hash>/node_modules/<pkg> symlinks
    // collapse to a single physical directory across the whole tree.
    let real: string;
    try {
      real = await realpath(childPath);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);

    const pkg = await detectPackage(real);
    if (pkg) yield pkg;
  }
}
