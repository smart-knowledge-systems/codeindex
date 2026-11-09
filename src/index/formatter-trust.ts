// ---------------------------------------------------------------------------
// Formatter trust
//
// The formatter is spawned as a subprocess during indexing. A command taken
// from a repo's own `.codeindex.json`, or auto-detected from its files (e.g.
// prettier, which executes `prettier.config.js` and any configured plugins),
// is controlled by whoever authored the repo — so indexing a cloned repo
// could run arbitrary code. Repo-sourced formatters therefore only run once
// the user has trusted that exact command for that repo. Trust lives outside
// the repo, next to the global config.
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { detectFormatter, getGlobalConfigPath } from "../config";
import type { CodeindexConfig } from "../search/types";

type TrustStore = Record<string, string>;

function trustStorePath(): string {
  return path.join(path.dirname(getGlobalConfigPath()), "trusted-formatters.json");
}

function repoKey(repoRoot: string): string {
  try {
    return fs.realpathSync(repoRoot);
  } catch {
    return path.resolve(repoRoot);
  }
}

async function readTrustStore(): Promise<TrustStore> {
  try {
    const data: unknown = await Bun.file(trustStorePath()).json();
    return data && typeof data === "object" && !Array.isArray(data) ? (data as TrustStore) : {};
  } catch {
    return {};
  }
}

/** Record that the user trusts `command` as the formatter for `repoRoot`. */
export async function trustFormatter(repoRoot: string, command: string): Promise<void> {
  const store = await readTrustStore();
  const filePath = trustStorePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await Bun.write(
    filePath,
    JSON.stringify({ ...store, [repoKey(repoRoot)]: command }, null, 2) + "\n",
  );
}

/** Formatter set in the repo's own `.codeindex.json`, if any. */
async function readRepoFormatter(repoRoot: string): Promise<string | null | undefined> {
  try {
    const local = (await Bun.file(path.join(repoRoot, ".codeindex.json")).json()) as Record<
      string,
      unknown
    >;
    if (!("formatter" in local)) return undefined;
    return typeof local.formatter === "string" ? local.formatter : null;
  } catch {
    return undefined;
  }
}

const warned = new Set<string>();

/**
 * Resolve the formatter command to run for `repoRoot`, or null to hash raw
 * content. A formatter from the user's global config is used as-is; one from
 * the repo's `.codeindex.json` or auto-detection is used only if trusted.
 */
export async function resolveFormatter(
  repoRoot: string,
  config: CodeindexConfig,
): Promise<string | null> {
  const repoFormatter = await readRepoFormatter(repoRoot);
  if (repoFormatter === undefined && config.formatter) return config.formatter; // global config
  if (repoFormatter === null) return null; // repo explicitly disables formatting

  const candidate = repoFormatter ?? (await detectFormatter(repoRoot));
  if (!candidate) return null;

  const store = await readTrustStore();
  if (store[repoKey(repoRoot)] === candidate) return candidate;

  const key = `${repoKey(repoRoot)}\0${candidate}`;
  if (!warned.has(key)) {
    warned.add(key);
    process.stderr.write(
      `codeindex: not running formatter "${candidate}" — it comes from this repo and is not trusted.\n` +
        `  To trust it: codeindex config --formatter "${candidate}"\n`,
    );
  }
  return null;
}
