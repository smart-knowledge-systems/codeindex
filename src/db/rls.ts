import { getPg } from "./pg";

type PgTransaction = import("bun").TransactionSQL;

function assertIntegerIds(repoIds: number[]): void {
  for (const id of repoIds) {
    if (typeof id !== "number" || !Number.isInteger(id)) {
      throw new Error(`Invalid repo ID: ${String(id)}`);
    }
  }
}

/**
 * Run a function within a transaction with RLS scope set.
 * The `tx` argument passed to `fn` must be used for all queries
 * inside the callback to ensure they run on the scoped connection.
 * The scope is automatically cleared when the transaction ends.
 */
export async function withRepoScope<T>(
  repoIds: number[],
  fn: (tx: PgTransaction) => Promise<T>,
): Promise<T> {
  if (process.env.CODEINDEX_RLS_DISABLED === "1") {
    const pg = await getPg();
    return pg.begin(async (tx) => fn(tx));
  }
  assertIntegerIds(repoIds);
  const pg = await getPg();
  const arrayStr = `{${repoIds.join(",")}}`;
  return pg.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.current_repo_ids', $1, true)`, [arrayStr]);
    return fn(tx);
  });
}
