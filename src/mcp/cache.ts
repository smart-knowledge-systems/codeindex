import crypto from "crypto";
import { logEvent } from "../logging";

interface CacheEntry {
  embedding: number[];
  createdAt: number;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ENTRIES = 1000;

/**
 * LRU cache for embedding vectors, keyed by SHA-256 hash of input text.
 *
 * NOTE: This class intentionally uses mutable Map state for performance.
 * Map insertion-order semantics give us O(1) LRU eviction without a
 * separate doubly-linked list. The trade-off (mutation over immutability)
 * is confined to this class boundary — callers interact via get/set only.
 */
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
    const exists = this.cache.has(key);
    // Delete first to refresh LRU position (Map preserves insertion order)
    if (exists) this.cache.delete(key);
    // Evict oldest if at capacity (only when adding a new key)
    if (!exists && this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { embedding, createdAt: Date.now() });
  }

  stats(): { hits: number; misses: number; size: number; hit_rate: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      hit_rate: total > 0 ? this.hits / total : 0,
    };
  }

  /** Emit cache statistics as a structured log event. */
  logStats(): void {
    const { hits, misses, size, hit_rate } = this.stats();
    logEvent({
      event: "infra.cache.stats",
      hits,
      misses,
      size,
      hit_rate,
    });
  }
}
