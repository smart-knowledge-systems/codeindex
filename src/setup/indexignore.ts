import { existsSync } from "fs";
import path from "path";
import { logEvent } from "../logging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexIgnorePattern {
  pattern: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directories that typically contain non-code data when they have many files. */
const DATA_DIRS = [
  "data",
  "datasets",
  "testdata",
  "fixtures",
  "samples",
  "output",
  "cache",
  "tmp",
  "archive",
  "audit",
  "models",
  "static",
];

/** Directories that are always non-code. */
const ALWAYS_EXCLUDE_DIRS = [
  "vendor",
  "third_party",
  "external",
  "coverage",
  ".nyc_output",
  "htmlcov",
  "playwright-report",
  "test-results",
];

/** Build artifact directories not in codeindex soft defaults. */
const BUILD_DIRS = ["target", "out"];

/** Media/binary extensions to check. */
const MEDIA_EXTS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".mp4",
  ".mp3",
  ".wav",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".ico",
  ".pdf",
];

/** Database file patterns. */
const DB_PATTERNS = ["*.db", "*.db-shm", "*.db-wal", "*.sqlite"];

// ---------------------------------------------------------------------------
// Pure pattern builders — each returns an array, no mutation
// ---------------------------------------------------------------------------

/** Patterns for data directories that exceed the file threshold. */
function dataDirPatterns(repoPath: string, dirCounts: Map<string, number>): IndexIgnorePattern[] {
  return DATA_DIRS.flatMap((dir) => {
    if (!existsSync(path.join(repoPath, dir))) return [];
    const count = dirCounts.get(dir) ?? 0;
    return count > 10 ? [{ pattern: `${dir}/`, reason: `data directory (${count} files)` }] : [];
  });
}

/** Patterns for directories that are always excluded. */
function alwaysExcludePatterns(repoPath: string): IndexIgnorePattern[] {
  return ALWAYS_EXCLUDE_DIRS.filter((dir) => existsSync(path.join(repoPath, dir))).map((dir) => ({
    pattern: `${dir}/`,
    reason: "non-code directory",
  }));
}

/** Patterns for build artifact directories. */
function buildDirPatterns(repoPath: string): IndexIgnorePattern[] {
  return BUILD_DIRS.filter((dir) => existsSync(path.join(repoPath, dir))).map((dir) => ({
    pattern: `${dir}/`,
    reason: "build artifacts",
  }));
}

/** Pattern for public/ directory if present. */
function publicDirPatterns(repoPath: string): IndexIgnorePattern[] {
  return existsSync(path.join(repoPath, "public"))
    ? [{ pattern: "public/", reason: "static assets" }]
    : [];
}

/** Patterns for media files that exceed threshold. */
function mediaPatterns(mediaCounts: Map<string, number>): IndexIgnorePattern[] {
  return [...mediaCounts.entries()].flatMap(([ext, count]) =>
    count > 5 ? [{ pattern: `*${ext}`, reason: `${count} media/binary files` }] : [],
  );
}

/** Patterns for database files found in root. */
function dbFilePatterns(entries: string[]): IndexIgnorePattern[] {
  return DB_PATTERNS.flatMap((pat) => {
    const ext = pat.replace("*", "");
    return entries.some((e) => e.endsWith(ext)) ? [{ pattern: pat, reason: "database file" }] : [];
  });
}

// ---------------------------------------------------------------------------
// I/O boundary — filesystem reads
// ---------------------------------------------------------------------------

async function fileCountInDir(dirPath: string): Promise<number> {
  try {
    const { readdir } = await import("fs/promises");
    const entries = await readdir(dirPath, { recursive: true });
    return entries.length;
  } catch {
    return 0;
  }
}

/** Count occurrences of each extension in git-tracked files. */
async function countExtensions(repoPath: string, exts: string[]): Promise<Map<string, number>> {
  try {
    const proc = Bun.spawn(["git", "ls-files"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;

    return text.split("\n").reduce((counts, line) => {
      for (const ext of exts) {
        if (line.toLowerCase().endsWith(ext)) {
          counts.set(ext, (counts.get(ext) ?? 0) + 1);
        }
      }
      return counts;
    }, new Map<string, number>());
  } catch {
    return new Map();
  }
}

/** Read directory entries (I/O boundary for hasFilesWithExtension). */
async function readDirEntries(dirPath: string): Promise<string[]> {
  try {
    const { readdir } = await import("fs/promises");
    return await readdir(dirPath);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate .indexignore patterns by analyzing a repo's structure.
 * Combines patterns from multiple pure builders, each producing
 * independent arrays that are concatenated without mutation.
 */
export async function generateIndexIgnore(repoPath: string): Promise<IndexIgnorePattern[]> {
  // Gather I/O results at the boundary — parallelize independent reads
  const existingDataDirs = DATA_DIRS.filter((dir) => existsSync(path.join(repoPath, dir)));
  const [dirCountEntries, mediaCounts, rootEntries] = await Promise.all([
    Promise.all(
      existingDataDirs.map(
        async (dir) => [dir, await fileCountInDir(path.join(repoPath, dir))] as const,
      ),
    ),
    countExtensions(repoPath, MEDIA_EXTS),
    readDirEntries(repoPath),
  ]);
  const dirCounts = new Map(dirCountEntries);

  // Combine patterns from pure builders
  const patterns = [
    ...dataDirPatterns(repoPath, dirCounts),
    ...alwaysExcludePatterns(repoPath),
    ...buildDirPatterns(repoPath),
    ...publicDirPatterns(repoPath),
    ...mediaPatterns(mediaCounts),
    ...dbFilePatterns(rootEntries),
  ];

  logEvent({
    event: "infra.indexignore.generated",
    patternCount: patterns.length,
  });

  return patterns;
}

/**
 * Write .indexignore file. Returns true if written, false if skipped.
 */
export async function writeIndexIgnore(
  repoPath: string,
  patterns: IndexIgnorePattern[],
  force = false,
): Promise<boolean> {
  const filePath = path.join(repoPath, ".indexignore");
  if (!force && existsSync(filePath)) return false;
  if (patterns.length === 0) {
    await Bun.write(
      filePath,
      "# codeindex: exclude non-code assets\n# (no patterns detected — defaults are sufficient)\n",
    );
    logEvent({ event: "infra.indexignore.written", patternCount: 0 });
    return true;
  }

  const lines = [
    "# codeindex: exclude non-code assets",
    "",
    ...patterns.flatMap((p) => [`# ${p.reason}`, p.pattern]),
    "",
  ];

  await Bun.write(filePath, lines.join("\n"));
  logEvent({ event: "infra.indexignore.written", patternCount: patterns.length });
  return true;
}
