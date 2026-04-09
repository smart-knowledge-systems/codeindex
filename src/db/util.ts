// Re-export of vector serialization helpers from @easier-idx/core.
// Kept as a local shim so existing internal call sites don't need to
// update their import paths; future work may migrate direct imports
// to "@easier-idx/core/db".
export { serializeEmbedding, deserializeEmbedding, cosineSimilarity } from "@easier-idx/core/db";
