import path from "path";
import type { CodeindexConfig } from "./search/types";

const DEFAULTS: CodeindexConfig = {
  store: "pg",
  pg: {
    host: "localhost",
    port: 5432,
    database: "codeindex",
    user: process.env.USER ?? "postgres",
  },
  sqlite: {
    path: ".codeindex.db",
  },
  embedding: {
    model: "text-embedding-3-small",
    dimensions: 1536,
    provider: "openai",
  },
  scoring: {
    commitDecay: 0.2,
    commitDepth: 5,
    alpha: 0.15,
    beta: 0.2,
    gamma: 0.1,
    minScore: 0.3,
    parentBoostMultiplier: 0.3,
    hybridWeight: 0.3,
    lengthPenaltyWeight: 0.1,
  },
  formatter: null,
  skeletonFallbackLines: 50,
  costCap: { maxCostPerReindex: null, warnAt: null },
};

const GLOBAL_CONFIG_PATH = path.join(
  process.env.HOME ?? "~",
  ".config",
  "codeindex",
  "config.json",
);
const LOCAL_CONFIG_FILE = ".codeindex.json";

async function loadJsonFile(filePath: string): Promise<Partial<CodeindexConfig>> {
  try {
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return (await file.json()) as Partial<CodeindexConfig>;
    }
  } catch {
    // ignore missing/invalid config
  }
  return {};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(base: any, override: any): any {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const val = override[key];
    if (val !== undefined && val !== null && typeof val === "object" && !Array.isArray(val)) {
      result[key] = deepMerge(result[key] ?? {}, val);
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

export async function loadConfig(repoRoot?: string): Promise<CodeindexConfig> {
  const global = await loadJsonFile(GLOBAL_CONFIG_PATH);
  const localPath = repoRoot ? path.join(repoRoot, LOCAL_CONFIG_FILE) : LOCAL_CONFIG_FILE;
  const local = await loadJsonFile(localPath);
  return deepMerge(
    deepMerge(DEFAULTS, global as Partial<CodeindexConfig>),
    local as Partial<CodeindexConfig>,
  );
}

const FORMATTER_CHECKS: {
  files: string[];
  command: string;
  check?: (f: string) => Promise<boolean>;
}[] = [
  { files: ["biome.json", "biome.jsonc"], command: "biome format" },
  {
    files: [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.yaml",
      ".prettierrc.yml",
      ".prettierrc.js",
      ".prettierrc.cjs",
      ".prettierrc.mjs",
      "prettier.config.js",
      "prettier.config.cjs",
      "prettier.config.mjs",
    ],
    command: "prettier",
  },
  { files: ["rustfmt.toml", ".rustfmt.toml"], command: "rustfmt" },
  {
    files: ["pyproject.toml"],
    command: "black",
    check: async (f) => {
      const content = await Bun.file(f).text();
      return content.includes("[tool.black]");
    },
  },
  {
    files: ["pyproject.toml"],
    command: "ruff format",
    check: async (f) => {
      const content = await Bun.file(f).text();
      return content.includes("[tool.ruff]");
    },
  },
  { files: [".clang-format"], command: "clang-format" },
];

export async function detectFormatter(repoRoot: string): Promise<string | null> {
  for (const entry of FORMATTER_CHECKS) {
    for (const fileName of entry.files) {
      const filePath = path.join(repoRoot, fileName);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        if (entry.check) {
          if (await entry.check(filePath)) return entry.command;
        } else {
          return entry.command;
        }
      }
    }
  }

  // Check for Go files
  const glob = new Bun.Glob("**/*.go");
  for await (const _ of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
    return "gofmt";
  }

  return null;
}
