import path from "path";
import ignore from "ignore";

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

async function loadIgnoreFile(filePath: string): Promise<string[]> {
  try {
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const text = await file.text();
      return text.split("\n");
    }
  } catch {
    // ignore missing/unreadable files
  }
  return [];
}

export async function* walkRepo(repoRoot: string): AsyncGenerator<string> {
  const hardIg = ignore();
  hardIg.add(HARD_IGNORED);

  // Soft defaults → .gitignore → .indexignore (later patterns override earlier)
  const ig = ignore();
  ig.add(DEFAULT_IGNORED);

  const gitignorePatterns = await loadIgnoreFile(path.join(repoRoot, ".gitignore"));
  if (gitignorePatterns.length > 0) {
    ig.add(gitignorePatterns);
  }

  const indexignorePatterns = await loadIgnoreFile(path.join(repoRoot, ".indexignore"));
  if (indexignorePatterns.length > 0) {
    ig.add(indexignorePatterns);
  }

  const glob = new Bun.Glob("**/*");

  for await (const entry of glob.scan({ cwd: repoRoot, onlyFiles: true, followSymlinks: false })) {
    if (!hardIg.ignores(entry) && !ig.ignores(entry)) {
      yield entry;
    }
  }
}
