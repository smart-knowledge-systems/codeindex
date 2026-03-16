import path from "path";
import { detectFormatter } from "../config";
import { ensurePgSchema, ensureSqliteSchema } from "../db/schema";

export async function cmdInit(repoRoot: string) {
  const configPath = path.join(repoRoot, ".codeindex.json");
  const configFile = Bun.file(configPath);

  if (await configFile.exists()) {
    console.log("Already initialized.");
    return;
  }

  const gitExists = await Bun.file(path.join(repoRoot, ".git", "HEAD")).exists();
  if (!gitExists) {
    console.error("Error: not a git repository. Run `git init` first.");
    process.exit(1);
  }

  const store =
    process.env.PGHOST || process.env.DATABASE_URL ? "pg" : ("sqlite" as "pg" | "sqlite");
  const formatter = await detectFormatter(repoRoot);

  const config: Record<string, unknown> = { store };
  if (formatter) config.formatter = formatter;

  await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n");

  if (store === "sqlite") {
    await ensureSqliteSchema(repoRoot);
    const dbName = ".codeindex.db";
    console.log(`Initialized codeindex (store: sqlite, db: ${dbName})`);
  } else {
    await ensurePgSchema();
    console.log(`Initialized codeindex (store: pg)`);
  }
}
