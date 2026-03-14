import crypto from "crypto";

interface CacheEntry {
  embedding: number[];
  createdAt: number;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ENTRIES = 1000;

export class EmbeddingCache {
  private cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  private computeKey(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
  }

  get(text: string): number[] | undefined {
    const key = this.computeKey(text);
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() - entry.createdAt > TTL_MS) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }
    // Move to end for LRU
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.embedding;
  }

  set(text: string, embedding: number[]): void {
    const key = this.computeKey(text);
    // Evict oldest if at capacity
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { embedding, createdAt: Date.now() });
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.cache.size };
  }
}
