import path from "path";
import {
  loadConfig as loadConfigCore,
  getGlobalConfigPath as getGlobalConfigPathCore,
  writeGlobalConfig as writeGlobalConfigCore,
} from "@easier-idx/core/config";
import type { CodeindexConfig } from "./search/types";

const APP_NAME = "codeindex";

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
    commitDepth: 10,
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
  languageProfiles: {
    go: { beta: 0.35, parentBoostMultiplier: 0.4 },
    java: { beta: 0.1, parentBoostMultiplier: 0.15 },
    kotlin: { beta: 0.1, parentBoostMultiplier: 0.15 },
    python: { beta: 0.25 },
  },
  reranking: {
    enabled: false,
    importProximityWeight: 0.05,
    crossRepoWeight: 0.03,
    coChangeWeight: 0.04,
  },
  providerProfiles: {
    ollama: { hybridWeight: 0.45, alpha: 0.2 },
  },
  dedup: {
    enabled: true,
    backend: null, // null = unprompted; first reindex triggers interactive chooser
  },
  search: {
    useBlobSchema: true,
  },
};

/**
 * Load codeindex config by merging defaults → global (~/.config/codeindex/config.json)
 * → local (.codeindex.json). Delegates to @easier-idx/core's generic loader.
 */
export async function loadConfig(repoRoot?: string): Promise<CodeindexConfig> {
  return loadConfigCore<CodeindexConfig>(APP_NAME, DEFAULTS, repoRoot);
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

export function getGlobalConfigPath(): string {
  return getGlobalConfigPathCore(APP_NAME);
}

export async function globalConfigExists(): Promise<boolean> {
  return await Bun.file(getGlobalConfigPath()).exists();
}

export async function writeGlobalConfig(config: Partial<CodeindexConfig>): Promise<string> {
  return writeGlobalConfigCore<CodeindexConfig>(APP_NAME, config);
}

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
