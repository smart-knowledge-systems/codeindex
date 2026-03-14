/**
 * Embedding provider interface for pluggable embedding backends.
 * Providers must implement batch and single embedding methods.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  embedSingle(text: string): Promise<number[]>;
}
