import fs from "fs";
import path from "path";

const HOOK_MARKER = "# codeindex hook";

const HOOK_LINES = `${HOOK_MARKER}
files=$(git diff-tree --no-commit-id --name-only -r HEAD)
commit=$(git rev-parse HEAD)
codeindex update --files $files --commit $commit`;

const FULL_HOOK_SCRIPT = `#!/bin/sh
${HOOK_LINES}
`;

export async function installHook(repoRoot: string): Promise<void> {
  const hooksDir = path.join(repoRoot, ".git", "hooks");
  const hookPath = path.join(hooksDir, "post-commit");

  // Ensure .git/hooks directory exists
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const hookFile = Bun.file(hookPath);
  const exists = await hookFile.exists();

  if (exists) {
    const existing = await hookFile.text();

    // Don't append if codeindex lines are already present
    if (existing.includes(HOOK_MARKER)) {
      return;
    }

    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    const updated = existing + separator + HOOK_LINES + "\n";
    await Bun.write(hookPath, updated);
  } else {
    await Bun.write(hookPath, FULL_HOOK_SCRIPT);
  }

  // Make the hook executable
  const chmod = Bun.spawn(["chmod", "+x", hookPath]);
  await chmod.exited;
}
