import type { EmbeddingProvider } from "@easier-idx/embedding";
import {
  OpenAIEmbeddingProvider,
  OllamaEmbeddingProvider,
  RemoteEmbeddingProvider,
} from "@easier-idx/embedding/providers";
import type { CodeindexConfig } from "./search/types";

const DEFAULT_KEY = "openai:text-embedding-3-small:1536:";

function providerCacheKey(config?: CodeindexConfig): string {
  if (!config) return DEFAULT_KEY;
  const { provider, model, dimensions, ollamaUrl, remoteUrl } = config.embedding;
  return `${provider}:${model}:${dimensions}:${ollamaUrl ?? ""}:${remoteUrl ?? ""}`;
}

function createProvider(config?: CodeindexConfig): EmbeddingProvider {
  if (!config) return new OpenAIEmbeddingProvider();
  const { provider, model, dimensions, ollamaUrl, remoteUrl, remoteAuth } = config.embedding;
  if (provider === "ollama") return new OllamaEmbeddingProvider(model, dimensions, ollamaUrl);
  if (provider === "remote")
    return new RemoteEmbeddingProvider(model, dimensions, remoteUrl, remoteAuth);
  return new OpenAIEmbeddingProvider(model, dimensions);
}

const cache = new Map<string, EmbeddingProvider>();

/** Get (or construct and cache) an embedding provider for the given config. */
export function getProvider(config?: CodeindexConfig): EmbeddingProvider {
  const key = providerCacheKey(config);
  let p = cache.get(key);
  if (!p) {
    p = createProvider(config);
    cache.set(key, p);
  }
  return p;
}
