import { getPg } from "./pg";

function assertIntegerIds(repoIds: number[]): void {
  for (const id of repoIds) {
    if (typeof id !== "number" || !Number.isInteger(id)) {
      throw new Error(`Invalid repo ID: ${String(id)}`);
    }
  }
}

/**
 * Set the repo scope for the current database session.
 * All subsequent queries will be filtered by RLS policies.
 */
export async function setRepoScope(repoIds: number[]): Promise<void> {
  if (process.env.CODEINDEX_RLS_DISABLED === "1") return;
  assertIntegerIds(repoIds);
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

/**
 * Run a function within a transaction with RLS scope set.
 * The scope is automatically cleared when the transaction ends.
 */
export async function withRepoScope<T>(repoIds: number[], fn: () => Promise<T>): Promise<T> {
  if (process.env.CODEINDEX_RLS_DISABLED === "1") return fn();
  assertIntegerIds(repoIds);
  const pg = await getPg();
  const arrayStr = `{${repoIds.join(",")}}`;
  return pg.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_repo_ids = '${arrayStr}'`);
    return fn();
  });
}
