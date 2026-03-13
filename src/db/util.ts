/** Serialize a number[] embedding to a binary buffer for sqlite-vec vec0 tables. */
export function serializeEmbedding(embedding: number[]): Buffer {
  const buf = Buffer.allocUnsafe(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buf.writeFloatLE(embedding[i], i * 4);
  }
  return buf;
}

/** Compute cosine similarity between two vectors. Returns value in [-1, 1]. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Deserialize a binary buffer (little-endian floats) back to number[]. */
export function deserializeEmbedding(buf: Buffer): number[] {
  const floats: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    floats.push(buf.readFloatLE(i));
  }
  return floats;
}
