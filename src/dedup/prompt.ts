/**
 * First-use interactive chooser for the dedup backend. Triggered from the
 * reindex command when config.dedup.backend === null. Persists the user's
 * choice to the global config so it never asks twice.
 *
 * Non-interactive sessions (no TTY) silently default to SQLite — local-first
 * is always safe.
 */

import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { loadConfig, writeGlobalConfig, getGlobalConfigPath } from "../config";
import type { CodeindexConfig, DedupConfig } from "../search/types";

export type DedupBackendChoice = "pg" | "sqlite" | "disable";

/**
 * Prompt the user to pick a dedup backend if they haven't already. Returns
 * the resolved choice. Always persists to the global config on first answer.
 */
export async function ensureDedupBackend(
  config: CodeindexConfig,
): Promise<{ backend: "pg" | "sqlite" | null; enabled: boolean }> {
  const dedup = config.dedup;
  if (!dedup) {
    return { backend: "sqlite", enabled: true };
  }
  if (!dedup.enabled) {
    return { backend: dedup.backend, enabled: false };
  }
  if (dedup.backend !== null) {
    return { backend: dedup.backend, enabled: true };
  }

  const choice = await chooseBackend();
  await persistChoice(choice);

  if (choice === "disable") return { backend: null, enabled: false };
  return { backend: choice, enabled: true };
}

async function chooseBackend(): Promise<DedupBackendChoice> {
  // Non-interactive fallback — silently pick SQLite (local-first default).
  if (!stdin.isTTY || !stdout.isTTY) {
    process.stderr.write(
      "[dedup] non-interactive session — defaulting to local SQLite global store at ~/.codeindex/global.db\n",
    );
    return "sqlite";
  }

  process.stderr.write(
    "\nDependency dedup is available. The global store caches embeddings across\n" +
      "every repo on this machine — indexing repo #2 that shares deps with repo #1\n" +
      "costs ~zero embedding spend.\n\n" +
      "  [p] Postgres   (recommended if you already use the pg backend)\n" +
      "  [s] SQLite     (local-first, zero-config, ~/.codeindex/global.db)\n" +
      "  [d] Disable    (skip dedup entirely)\n\n",
  );

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const answer = (await rl.question("Choose [p/s/d] (default s): ")).trim().toLowerCase();
      if (answer === "" || answer === "s" || answer === "sqlite") return "sqlite";
      if (answer === "p" || answer === "pg" || answer === "postgres") return "pg";
      if (answer === "d" || answer === "disable" || answer === "no") return "disable";
      process.stderr.write("Please answer p, s, or d.\n");
    }
  } finally {
    rl.close();
  }
}

async function persistChoice(choice: DedupBackendChoice): Promise<void> {
  const existing = await loadConfig();
  const dedup: DedupConfig = {
    enabled: choice !== "disable",
    backend: choice === "disable" ? null : choice,
    ...(existing.dedup?.sqlitePath ? { sqlitePath: existing.dedup.sqlitePath } : {}),
  };
  // We rewrite *only* the dedup section to avoid clobbering other global keys.
  // loadConfig already merges defaults; persisting just the override is enough.
  const merged = { ...existing, dedup };
  await writeGlobalConfig(merged);
  process.stderr.write(`[dedup] saved choice to ${getGlobalConfigPath()}\n`);
}
