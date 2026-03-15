import fs from "fs";
import path from "path";
import { logEvent } from "../logging";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK_MARKER = "# codeindex hook";

const HOOK_LINES = `${HOOK_MARKER}
files=$(git diff-tree --no-commit-id --name-only -r HEAD)
commit=$(git rev-parse HEAD)
codeindex update --files $files --commit $commit`;

const FULL_HOOK_SCRIPT = `#!/bin/sh
${HOOK_LINES}
`;

// ---------------------------------------------------------------------------
// Types: discriminated union for hook state
// ---------------------------------------------------------------------------

type HookState =
  | { readonly kind: "does-not-exist"; readonly hookPath: string }
  | { readonly kind: "already-installed"; readonly hookPath: string }
  | { readonly kind: "needs-append"; readonly hookPath: string; readonly existing: string };

export type HookAction = "created" | "appended" | "skipped";

export interface HookInstallResult {
  hookPath: string;
  action: HookAction;
  chmodSucceeded: boolean;
}

// ---------------------------------------------------------------------------
// Pure core: inspect state → decide action
// ---------------------------------------------------------------------------

/** Determine what content to write (if any) based on the current hook state. */
function decideHookContent(state: HookState): { action: HookAction; content: string | null } {
  switch (state.kind) {
    case "does-not-exist":
      return { action: "created", content: FULL_HOOK_SCRIPT };
    case "already-installed":
      return { action: "skipped", content: null };
    case "needs-append": {
      const separator = state.existing.endsWith("\n") ? "\n" : "\n\n";
      return { action: "appended", content: state.existing + separator + HOOK_LINES + "\n" };
    }
  }
}

// ---------------------------------------------------------------------------
// Impure shell: file I/O and process spawning
// ---------------------------------------------------------------------------

/** Read the file system to determine current hook state. */
async function readHookState(hookPath: string): Promise<HookState> {
  const hookFile = Bun.file(hookPath);
  const exists = await hookFile.exists();

  if (!exists) return { kind: "does-not-exist", hookPath };

  const existing = await hookFile.text();
  if (existing.includes(HOOK_MARKER)) return { kind: "already-installed", hookPath };

  return { kind: "needs-append", hookPath, existing };
}

/** Write hook file and make it executable. Returns whether chmod succeeded. */
async function writeAndChmod(hookPath: string, content: string): Promise<boolean> {
  await Bun.write(hookPath, content);
  const chmod = Bun.spawn(["chmod", "+x", hookPath]);
  await chmod.exited;
  return chmod.exitCode === 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function installHook(repoRoot: string): Promise<HookInstallResult> {
  const hooksDir = path.join(repoRoot, ".git", "hooks");
  const hookPath = path.join(hooksDir, "post-commit");

  // Ensure .git/hooks directory exists
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const state = await readHookState(hookPath);
  const { action, content } = decideHookContent(state);

  const chmodSucceeded = content != null ? await writeAndChmod(hookPath, content) : true;

  logEvent({
    event: "infra.hook.install",
    hook_path: hookPath,
    action,
    chmod_succeeded: chmodSucceeded,
  });

  return { hookPath, action, chmodSucceeded };
}
