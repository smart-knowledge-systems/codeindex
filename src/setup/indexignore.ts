import { existsSync } from "fs";
import { readdir } from "fs/promises";
import path from "path";

export interface IndexIgnorePattern {
  pattern: string;
  reason: string;
}

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

/**
 * Generate .indexignore patterns by analyzing a repo's structure.
 */
export async function generateIndexIgnore(repoPath: string): Promise<IndexIgnorePattern[]> {
  const patterns: IndexIgnorePattern[] = [];

  // Check for data directories (only if large)
  for (const dir of DATA_DIRS) {
    const dirPath = path.join(repoPath, dir);
    if (!existsSync(dirPath)) continue;
    const count = await fileCountInDir(dirPath);
    if (count > 10) {
      patterns.push({ pattern: `${dir}/`, reason: `data directory (${count} files)` });
    }
  }

  // Check for always-excluded directories
  for (const dir of ALWAYS_EXCLUDE_DIRS) {
    if (existsSync(path.join(repoPath, dir))) {
      patterns.push({ pattern: `${dir}/`, reason: "non-code directory" });
    }
  }

  // Check for build artifact directories not in defaults
  for (const dir of BUILD_DIRS) {
    if (existsSync(path.join(repoPath, dir))) {
      patterns.push({ pattern: `${dir}/`, reason: "build artifacts" });
    }
  }

  // Check for public/ directory (Next.js/web apps — contains images, favicons)
  if (existsSync(path.join(repoPath, "public"))) {
    patterns.push({ pattern: "public/", reason: "static assets" });
  }

  // Check for media files by extension
  const mediaCounts = await countExtensions(repoPath, MEDIA_EXTS);
  for (const [ext, count] of mediaCounts) {
    if (count > 5) {
      patterns.push({ pattern: `*${ext}`, reason: `${count} media/binary files` });
    }
  }

  // Check for database files in root
  for (const pat of DB_PATTERNS) {
    const ext = pat.replace("*", "");
    const found = await hasFilesWithExtension(repoPath, ext);
    if (found) {
      patterns.push({ pattern: pat, reason: "database file" });
    }
  }

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
    return true;
  }

  const lines = ["# codeindex: exclude non-code assets", ""];
  for (const p of patterns) {
    lines.push(`# ${p.reason}`);
    lines.push(p.pattern);
  }
  lines.push("");

  await Bun.write(filePath, lines.join("\n"));
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileCountInDir(dirPath: string): Promise<number> {
  try {
    const entries = await readdir(dirPath, { recursive: true });
    return entries.length;
  } catch {
    return 0;
  }
}

async function countExtensions(repoPath: string, exts: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const proc = Bun.spawn(["git", "ls-files"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      for (const ext of exts) {
        if (line.toLowerCase().endsWith(ext)) {
          counts.set(ext, (counts.get(ext) ?? 0) + 1);
        }
      }
    }
  } catch {
    // ignore
  }
  return counts;
}

async function hasFilesWithExtension(dirPath: string, ext: string): Promise<boolean> {
  try {
    const entries = await readdir(dirPath);
    return entries.some((e) => e.endsWith(ext));
  } catch {
    return false;
  }
}
