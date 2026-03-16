import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline/promises";
import { GLOBAL_ENV_DIR, GLOBAL_ENV_PATH } from "../env";
import { writeGlobalConfig, getGlobalConfigPath } from "../config";
import type { CodeindexConfig } from "../search/types";

const PROVIDERS = [
  { key: "openai", label: "OpenAI", needsKey: true },
  { key: "ollama", label: "Ollama (local)", needsKey: false },
] as const;

type ProviderKey = (typeof PROVIDERS)[number]["key"];

/**
 * Read existing global .env as a key→value map.
 * Preserves comments and blank lines as-is when rewriting.
 */
function readEnvFile(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const content = readFileSync(GLOBAL_ENV_PATH, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
    }
  } catch {
    // file doesn't exist yet
  }
  return map;
}

/** Write key=value pairs to the global .env, preserving existing entries. */
function writeEnvFile(updates: Record<string, string>): void {
  mkdirSync(GLOBAL_ENV_DIR, { recursive: true });
  const existing = readEnvFile();
  for (const [k, v] of Object.entries(updates)) {
    existing.set(k, v);
  }
  const lines = [...existing.entries()].map(([k, v]) => `${k}=${v}`);
  writeFileSync(GLOBAL_ENV_PATH, lines.join("\n") + "\n");
}

async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

export async function cmdAuth(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Step 1: Pick provider
    console.log("\n  codeindex auth\n");
    console.log("  Select an embedding provider:\n");
    for (let i = 0; i < PROVIDERS.length; i++) {
      console.log(`    ${i + 1}) ${PROVIDERS[i].label}`);
    }
    console.log();

    let provider: ProviderKey | null = null;
    while (!provider) {
      const choice = await ask(rl, "  Provider [1]: ");
      const idx = choice === "" ? 0 : parseInt(choice, 10) - 1;
      if (idx >= 0 && idx < PROVIDERS.length) {
        provider = PROVIDERS[idx].key;
      } else {
        console.log("  Invalid choice, try again.");
      }
    }

    const selected = PROVIDERS.find((p) => p.key === provider)!;
    console.log(`\n  Selected: ${selected.label}`);

    if (selected.needsKey) {
      // Step 2a: API key
      const key = await ask(rl, "\n  API key: ");
      if (!key) {
        console.error("  No key provided. Aborting.");
        process.exit(1);
      }

      writeEnvFile({ CODEINDEX_OPENAI_API_KEY: key });
      console.log(`\n  [ok] Key saved to ${GLOBAL_ENV_PATH}`);
    } else {
      // Step 2b: Ollama URL
      const defaultUrl = "http://localhost:11434";
      const url = await ask(rl, `\n  Ollama URL [${defaultUrl}]: `);
      const ollamaUrl = url || defaultUrl;

      // Write Ollama URL to global config
      const globalConfigPath = getGlobalConfigPath();
      let existing: Partial<CodeindexConfig> = {};
      try {
        existing = await Bun.file(globalConfigPath).json();
      } catch {
        // no existing config
      }
      await writeGlobalConfig({
        ...existing,
        embedding: {
          ...(existing.embedding ?? {}),
          provider: "ollama",
          ollamaUrl,
        },
      } as Partial<CodeindexConfig>);

      console.log(`\n  [ok] Ollama provider configured (${ollamaUrl})`);
      console.log(`       Config: ${globalConfigPath}`);
    }

    console.log();
  } finally {
    rl.close();
  }
}
