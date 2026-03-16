// ---------------------------------------------------------------------------
// Scope filtering helpers
// ---------------------------------------------------------------------------

export const LANG_ALIASES: Record<string, string[]> = {
  ts: [".ts", ".tsx"],
  typescript: [".ts", ".tsx"],
  js: [".js", ".jsx"],
  javascript: [".js", ".jsx"],
  python: [".py"],
  py: [".py"],
  rust: [".rs"],
  rs: [".rs"],
  go: [".go"],
  java: [".java"],
  c: [".c", ".h"],
  cpp: [".cpp", ".hpp", ".cc", ".cxx", ".hh"],
  "c++": [".cpp", ".hpp", ".cc", ".cxx", ".hh"],
  csharp: [".cs"],
  "c#": [".cs"],
  cs: [".cs"],
  kotlin: [".kt", ".kts"],
  kt: [".kt", ".kts"],
  swift: [".swift"],
  ruby: [".rb"],
  rb: [".rb"],
  php: [".php"],
  lua: [".lua"],
  zig: [".zig"],
  elixir: [".ex", ".exs"],
  ex: [".ex", ".exs"],
};

export function resolveLangExtensions(langs: string[]): string[] {
  const exts = new Set<string>();
  for (const lang of langs) {
    const key = lang.toLowerCase();
    const mapped = LANG_ALIASES[key];
    if (mapped) {
      for (const e of mapped) exts.add(e);
    } else {
      // Treat as raw extension: ".foo" or "foo" -> ".foo"
      exts.add(key.startsWith(".") ? key : `.${key}`);
    }
  }
  return [...exts];
}

export function parseSince(since: string): Date {
  const match = since.match(/^(\d+)([dwm])$/);
  if (match) {
    const n = parseInt(match[1]);
    const unit = match[2];
    const now = new Date();
    if (unit === "d") now.setDate(now.getDate() - n);
    else if (unit === "w") now.setDate(now.getDate() - n * 7);
    else if (unit === "m") now.setMonth(now.getMonth() - n);
    return now;
  }
  // Try ISO date
  const d = new Date(since);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid --since value: "${since}". Use Nd, Nw, Nm, or ISO date.`);
  }
  return d;
}
