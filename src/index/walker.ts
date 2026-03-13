import path from "path";
import ignore from "ignore";

const ALWAYS_IGNORED = [
  ".git/",
  "node_modules/",
  ".codeindex.db",
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
  const ig = ignore();

  ig.add(ALWAYS_IGNORED);

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
    if (!ig.ignores(entry)) {
      yield entry;
    }
  }
}
