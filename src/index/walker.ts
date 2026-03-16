import path from "path";
import ignore from "ignore";
import { logEvent } from "../logging";

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
