import { applyMigrations, ensureSqliteVecTables } from "./migrate";

export async function ensurePgSchema() {
  const applied = await applyMigrations("pg");
  if (applied.length > 0) {
    console.error(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
  }
}

export async function ensureSqliteSchema(repoRoot?: string) {
  const applied = await applyMigrations("sqlite", repoRoot);
  await ensureSqliteVecTables(repoRoot);
  if (applied.length > 0) {
    console.error(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
  }
}
