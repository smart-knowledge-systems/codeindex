import { applyMigrations, ensureSqliteVecTables } from "./migrate";
import { logEvent } from "../logging";

export async function ensurePgSchema(): Promise<number[]> {
  const result = await applyMigrations("pg");
  if (result.tag === "err") throw result.error;
  if (result.versions.length > 0) {
    logEvent({
      event: "infra.schema.applied",
      backend: "pg",
      count: result.versions.length,
      versions: result.versions,
    });
  }
  return result.versions;
}

export async function ensureSqliteSchema(repoRoot?: string) {
  const result = await applyMigrations("sqlite", repoRoot);
  if (result.tag === "err") throw result.error;
  await ensureSqliteVecTables(repoRoot);
  if (result.versions.length > 0) {
    logEvent({
      event: "infra.schema.applied",
      backend: "sqlite",
      count: result.versions.length,
      versions: result.versions,
    });
  }
}
