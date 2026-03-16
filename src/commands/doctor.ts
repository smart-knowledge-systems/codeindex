import path from "path";
import { loadConfig } from "../config";
import {
  getCurrentSchemaVersion,
  getLatestMigrationVersion,
  checkEmbeddingDimensions,
} from "../db/migrate";
import { pgUnsafe } from "../db/pg";
import { getSqlite } from "../db/sqlite";

export async function cmdDoctor(repoRoot: string) {
  // Collect results immutably; derive overall status with every()
  const results: Array<{ label: string; passed: boolean; hint?: string }> = [];

  const check = (label: string, pass: boolean, hint?: string) => {
    const icon = pass ? "[ok]" : "[!!]";
    console.log(`${icon} ${label}`);
    if (!pass && hint) console.log(`     ${hint}`);
    results.push({ label, passed: pass, hint });
  };

  // 1. Git repo
  const gitExists = await Bun.file(path.join(repoRoot, ".git", "HEAD")).exists();
  check("Git repository", gitExists, "Run `git init` to initialize a repository.");

  // 2. OPENAI_API_KEY (or CODEINDEX_OPENAI_API_KEY)
  check(
    "OPENAI_API_KEY set",
    !!process.env.OPENAI_API_KEY,
    "Set OPENAI_API_KEY or CODEINDEX_OPENAI_API_KEY in your environment, or add it to ~/.config/codeindex/.env",
  );

  // 3. Config loadable
  let configOk = false;
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    config = await loadConfig(repoRoot);
    configOk = true;
  } catch {
    /* empty */
  }
  check(
    "Config loadable",
    configOk,
    "Check .codeindex.json for syntax errors. Run `codeindex init` to create one.",
  );

  // 4. Backend reachable
  if (config) {
    if (config.store === "pg") {
      try {
        await pgUnsafe("SELECT 1");
        check("PostgreSQL connection", true);
      } catch {
        check(
          "PostgreSQL connection",
          false,
          "Cannot connect to PostgreSQL. Check PGHOST, PGPORT, PGDATABASE env vars or pg config in .codeindex.json.",
        );
      }
    } else {
      try {
        await getSqlite(repoRoot);
        check("SQLite database", true);
      } catch {
        check("SQLite database", false, "Cannot open SQLite database file.");
      }
    }

    // 6. Schema created
    if (config.store === "pg") {
      try {
        const tables = await pgUnsafe(
          "SELECT count(*) as cnt FROM information_schema.tables WHERE table_name = 'files'",
        );
        check(
          "Schema created",
          (tables[0].cnt as number) > 0,
          "Run `codeindex init` or `codeindex reindex`.",
        );
      } catch {
        check("Schema created", false, "Run `codeindex init` or `codeindex reindex`.");
      }
    } else {
      try {
        const db = await getSqlite(repoRoot);
        const tables = db
          .prepare("SELECT count(*) as cnt FROM sqlite_master WHERE name = 'files'")
          .get() as { cnt: number };
        check("Schema created", tables.cnt > 0, "Run `codeindex init` or `codeindex reindex`.");
      } catch {
        check("Schema created", false, "Run `codeindex init` or `codeindex reindex`.");
      }
    }

    // Schema version check
    try {
      const current = await getCurrentSchemaVersion(config.store, repoRoot);
      const latest = await getLatestMigrationVersion(config.store);
      check(
        `Schema version (${current}/${latest})`,
        current >= latest,
        "Run `codeindex init` to apply pending migrations.",
      );
    } catch {
      check("Schema version", false, "Could not determine schema version.");
    }

    // Embedding dimension check (SQLite only — vec tables store dimension)
    if (config.store === "sqlite") {
      const dimWarning = await checkEmbeddingDimensions(repoRoot, config.embedding.dimensions);
      if (dimWarning) {
        check("Embedding dimensions", false, dimWarning);
      } else {
        check("Embedding dimensions", true);
      }
    }
  }

  // 5. claude CLI available
  try {
    const proc = Bun.spawn(["which", "claude"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    check(
      "claude CLI available",
      exitCode === 0,
      "Install claude CLI for directory summaries (optional).",
    );
  } catch {
    check("claude CLI available", false, "Install claude CLI for directory summaries (optional).");
  }

  // 6. Ollama check (if configured)
  if (config && config.embedding.provider === "ollama") {
    const { OllamaEmbeddingProvider } = await import("../index/providers/ollama");
    const ollama = new OllamaEmbeddingProvider(
      config.embedding.model,
      config.embedding.dimensions,
      config.embedding.ollamaUrl,
    );
    const { available, error } = await ollama.checkAvailability();
    check("Ollama server reachable", available, error);
  }

  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "\nAll checks passed." : "\nSome checks failed — see above.");
}
