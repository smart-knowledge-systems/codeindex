import type { EmbeddingProvider } from "@easier-idx/embedding";
import {
  OpenAIEmbeddingProvider,
  OllamaEmbeddingProvider,
  RemoteEmbeddingProvider,
} from "@easier-idx/embedding/providers";
import type { CodeindexConfig } from "../search/types";
import { logEvent } from "../logging";

const MAX_EMBED_CHARS = 4_000; // ~8000 tokens max; code averages ~2 tokens/char

function sanitize(text: string): string {
  if (text.length === 0) return " ";
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

const DEFAULT_KEY = "openai:text-embedding-3-small:1536:";

/** Build a cache key from embedding config. */
function providerCacheKey(config?: CodeindexConfig): string {
  if (!config) return DEFAULT_KEY;
  const { provider, model, dimensions, ollamaUrl, remoteUrl } = config.embedding;
  return `${provider}:${model}:${dimensions}:${ollamaUrl ?? ""}:${remoteUrl ?? ""}`;
}

/** Construct a new provider from config (pure factory — no caching). */
function createProvider(config?: CodeindexConfig): EmbeddingProvider {
  if (!config) return new OpenAIEmbeddingProvider();
  const { provider, model, dimensions, ollamaUrl, remoteUrl, remoteAuth } = config.embedding;
  if (provider === "ollama") return new OllamaEmbeddingProvider(model, dimensions, ollamaUrl);
  if (provider === "remote")
    return new RemoteEmbeddingProvider(model, dimensions, remoteUrl, remoteAuth);
  return new OpenAIEmbeddingProvider(model, dimensions);
}

/**
 * Provider cache — encapsulated singleton store.
 * Providers are stateless network clients, so caching avoids redundant instantiation.
 */
const providerCache = (() => {
  const cache = new Map<string, EmbeddingProvider>();
  return {
    getOrCreate(config?: CodeindexConfig): EmbeddingProvider {
      const key = providerCacheKey(config);
      const cached = cache.get(key);
      if (cached) return cached;
      const provider = createProvider(config);
      cache.set(key, provider);
      return provider;
    },
    clear(): void {
      cache.clear();
    },
  };
})();

/** Get or create the configured embedding provider. */
export function getProvider(config?: CodeindexConfig): EmbeddingProvider {
  return providerCache.getOrCreate(config);
}

/** Reset all cached providers. */
export function resetProvider(): void {
  providerCache.clear();
}

export async function embed(
  texts: string | string[],
  config?: CodeindexConfig,
): Promise<number[][]> {
  const input = (Array.isArray(texts) ? texts : [texts]).map(sanitize);
  const result = await getProvider(config).embed(input);
  logEvent({ event: "index.embed.complete", text_count: input.length });
  return result;
}

export async function embedSingle(text: string, config?: CodeindexConfig): Promise<number[]> {
  return getProvider(config).embedSingle(sanitize(text));
}
