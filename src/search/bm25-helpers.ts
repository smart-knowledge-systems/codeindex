export { buildBM25Context, type BM25Context } from "@easier-idx/core/search/bm25-helpers";

export function computeAvgTokenCount(rows: ReadonlyArray<{ skeleton: string | null }>): number {
  let totalTokenCount = 0;
  let skeletonCount = 0;
  for (const row of rows) {
    if (row.skeleton) {
      totalTokenCount += row.skeleton.length / 4;
      skeletonCount++;
    }
  }
  return skeletonCount > 0 ? totalTokenCount / skeletonCount : 1;
}
