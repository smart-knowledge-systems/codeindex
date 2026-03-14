import { applyMigrations, ensureSqliteVecTables } from "./migrate";
import { loadConfig } from "../config";

export async function ensurePgSchema() {
  const applied = await applyMigrations("pg");
  if (applied.length > 0) {
    console.error(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
  }
}

export async function ensureSqliteSchema(repoRoot?: string) {
  const config = await loadConfig(repoRoot);
  const applied = await applyMigrations("sqlite", repoRoot);
  await ensureSqliteVecTables(repoRoot, config.embedding.dimensions);
  if (applied.length > 0) {
    console.error(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
  }
}
