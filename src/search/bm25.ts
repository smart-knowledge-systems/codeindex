// ---------------------------------------------------------------------------
// BM25 keyword scorer for hybrid search
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the",
  "be",
  "to",
  "of",
  "and",
  "in",
  "that",
  "have",
  "it",
  "for",
  "not",
  "on",
  "with",
  "he",
  "as",
  "you",
  "do",
  "at",
  "this",
  "but",
  "his",
  "by",
  "from",
  "they",
  "we",
  "her",
  "she",
  "or",
  "an",
  "will",
  "my",
  "all",
  "if",
  "is",
  "are",
  "was",
  "were",
  "been",
  "has",
  "had",
  "its",
  "can",
]);

export function tokenize(text: string): string[] {
  const camelSplit = text.replace(/([a-z])([A-Z])/g, "$1 $2");
  return camelSplit
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word));
}

export interface BM25Index {
  termDocFreq: Map<string, number>;
  docTermFreqs: Map<string, Map<string, number>>;
  docLengths: Map<string, number>;
  avgDL: number;
  N: number;
}

export function buildIndex(docs: Array<{ id: string; text: string }>): BM25Index {
  const termDocFreq = new Map<string, number>();
  const docTermFreqs = new Map<string, Map<string, number>>();
  const docLengths = new Map<string, number>();
  let totalLength = 0;

  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    docLengths.set(doc.id, tokens.length);
    totalLength += tokens.length;

    const termFreq = new Map<string, number>();
    const seen = new Set<string>();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
      if (!seen.has(token)) {
        termDocFreq.set(token, (termDocFreq.get(token) ?? 0) + 1);
        seen.add(token);
      }
    }
    docTermFreqs.set(doc.id, termFreq);
  }

  return {
    termDocFreq,
    docTermFreqs,
    docLengths,
    avgDL: docs.length > 0 ? totalLength / docs.length : 1,
    N: docs.length,
  };
}

export function score(index: BM25Index, query: string, k1 = 1.2, b = 0.75): Map<string, number> {
  const queryTokens = tokenize(query);
  const scores = new Map<string, number>();

  for (const [docId, termFreq] of index.docTermFreqs) {
    const docLen = index.docLengths.get(docId) ?? 0;
    let docScore = 0;

    for (const qt of queryTokens) {
      const tf = termFreq.get(qt) ?? 0;
      if (tf === 0) continue;

      const df = index.termDocFreq.get(qt) ?? 0;
      const idf = Math.log((index.N - df + 0.5) / (df + 0.5) + 1);
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / index.avgDL)));
      docScore += idf * tfNorm;
    }

    if (docScore > 0) {
      scores.set(docId, docScore);
    }
  }

  return scores;
}
