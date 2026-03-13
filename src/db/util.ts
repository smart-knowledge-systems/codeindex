/** Serialize a number[] embedding to a binary buffer for sqlite-vec vec0 tables. */
export function serializeEmbedding(embedding: number[]): Buffer {
  const buf = Buffer.allocUnsafe(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buf.writeFloatLE(embedding[i], i * 4);
  }
  return buf;
}
