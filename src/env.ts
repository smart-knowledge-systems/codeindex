import path from "path";
import os from "os";
import { readFileSync } from "fs";

export const GLOBAL_ENV_DIR = path.join(process.env.HOME ?? os.homedir(), ".config", "codeindex");
export const GLOBAL_ENV_PATH = path.join(GLOBAL_ENV_DIR, ".env");

/**
 * Load codeindex's global .env file (~/.config/codeindex/.env).
 *
 * Variables are set only if not already present in the environment,
 * so local .env files (auto-loaded by Bun) and shell exports take precedence.
 *
 * Also promotes CODEINDEX_OPENAI_API_KEY → OPENAI_API_KEY when the latter
 * is not set, so codeindex can carry its own key without colliding with
 * per-project OpenAI keys.
 */
export function loadGlobalEnv(): void {
  try {
    const content = readFileSync(GLOBAL_ENV_PATH, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Don't override existing env vars (local .env / shell exports win)
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // File doesn't exist — that's fine
  }

  // Promote dedicated codeindex key if OPENAI_API_KEY isn't already set
  if (!process.env.OPENAI_API_KEY && process.env.CODEINDEX_OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = process.env.CODEINDEX_OPENAI_API_KEY;
  }
}
