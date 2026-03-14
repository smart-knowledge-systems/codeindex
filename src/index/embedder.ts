import type { EmbeddingProvider } from "./embedding-provider";
import type { CodeindexConfig } from "../search/types";
import { OpenAIEmbeddingProvider } from "./providers/openai";
import { OllamaEmbeddingProvider } from "./providers/ollama";

const MAX_EMBED_CHARS = 4_000; // ~8000 tokens max; code averages ~2 tokens/char

function sanitize(text: string): string {
  if (text.length === 0) return " ";
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

let _provider: EmbeddingProvider | null = null;
let _providerKey: string | null = null;

/** Get or create the configured embedding provider. */
export function getProvider(config?: CodeindexConfig): EmbeddingProvider {
  if (!config) {
    if (_provider) return _provider;
    _provider = new OpenAIEmbeddingProvider();
    _providerKey = "openai:text-embedding-3-small:1536";
    return _provider;
  }

  const { provider, model, dimensions, ollamaUrl } = config.embedding;
  const key = `${provider}:${model}:${dimensions}:${ollamaUrl ?? ""}`;

  if (_provider && _providerKey === key) return _provider;

  if (provider === "ollama") {
    _provider = new OllamaEmbeddingProvider(model, dimensions, ollamaUrl);
  } else {
    _provider = new OpenAIEmbeddingProvider(model, dimensions);
  }
  _providerKey = key;

  return _provider;
}

/** Reset the cached provider (useful when config changes). */
export function resetProvider(): void {
  _provider = null;
}

export async function embed(
  texts: string | string[],
  config?: CodeindexConfig,
): Promise<number[][]> {
  const input = (Array.isArray(texts) ? texts : [texts]).map(sanitize);
  return getProvider(config).embed(input);
}

export async function embedSingle(text: string, config?: CodeindexConfig): Promise<number[]> {
  return getProvider(config).embedSingle(sanitize(text));
}
