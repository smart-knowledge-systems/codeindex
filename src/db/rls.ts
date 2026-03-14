import { getPg } from "./pg";

/**
 * Set the repo scope for the current database session.
 * All subsequent queries will be filtered by RLS policies.
 */
export async function setRepoScope(repoIds: number[]): Promise<void> {
  if (process.env.CODEINDEX_RLS_DISABLED === "1") return;
  const pg = await getPg();
  const arrayStr = `{${repoIds.join(",")}}`;
  await pg.unsafe(`SET LOCAL app.current_repo_ids = '${arrayStr}'`);
}

/**
 * Clear the repo scope (within a transaction, this is automatic on commit/rollback).
 */
export async function clearRepoScope(): Promise<void> {
  if (process.env.CODEINDEX_RLS_DISABLED === "1") return;
  const pg = await getPg();
  await pg.unsafe(`RESET app.current_repo_ids`);
}
