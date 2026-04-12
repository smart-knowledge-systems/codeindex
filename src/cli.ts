export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that take a value argument. All others are treated as booleans. */
const VALUE_FLAGS = new Set([
  "min-score",
  "top-n",
  "lang",
  "dir",
  "since",
  "format",
  "scope",
  "out",
  "transport",
  "port",
  "workers",
  "budget",
  "files",
  "commit",
  "threshold",
  "config-name",
  "repo",
  "output",
  "exclude",
  "alpha",
  "beta",
  "gamma",
  "decay",
  "parent-boost-multiplier",
  "changed-since",
  "scan",
  "store",
  "name",
  "repos",
  "expires",
  "id",
  "path",
  "dataset",
  "baseline",
  "agents-md",
  "strategy",
  "top",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 1; // skip command
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (VALUE_FLAGS.has(key)) {
        const next = args[i + 1];
        flags[key] = next !== undefined ? next : "";
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return { command, positional, flags };
}

export function flag(parsed: ParsedArgs, name: string): string | undefined {
  const val = parsed.flags[name];
  return typeof val === "string" ? val : undefined;
}

export function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return name in parsed.flags;
}

/**
 * Warn on stderr about any flags not in the known set.
 */
export function warnUnknownFlags(parsed: ParsedArgs, knownFlags: string[]): void {
  const known = new Set(knownFlags);
  let warned = false;
  for (const key of Object.keys(parsed.flags)) {
    if (!known.has(key)) {
      console.error(`Warning: unknown flag --${key}`);
      warned = true;
    }
  }
  if (warned) {
    console.error(`Hint: run 'codeindex --llm' for the full agent-oriented usage doc.`);
  }
}
