// ---------------------------------------------------------------------------
// BM25 index helpers — pure data prep
// ---------------------------------------------------------------------------

import { buildIndex as buildBM25Index, score as scoreBM25 } from "@easier-idx/core/search/bm25";

export interface BM25Context {
  readonly scores: Map<string, number>;
  readonly maxScore: number;
}

export function buildBM25Context(
  docs: Array<{ id: string; text: string }>,
  query: string,
): BM25Context {
  if (docs.length === 0) return { scores: new Map(), maxScore: 1 };
  const index = buildBM25Index(docs);
  const scores = scoreBM25(index, query);
  const maxScore = scores.size > 0 ? Math.max(...scores.values()) : 1;
  return { scores, maxScore };
}

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
