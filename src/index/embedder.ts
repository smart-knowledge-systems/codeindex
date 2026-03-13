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

/** Get or create the configured embedding provider. */
export function getProvider(config?: CodeindexConfig): EmbeddingProvider {
  if (_provider) return _provider;
  if (!config) {
    // Default to OpenAI if no config
    _provider = new OpenAIEmbeddingProvider();
    return _provider;
  }

  const { provider, model, dimensions, ollamaUrl } = config.embedding;

  if (provider === "ollama") {
    _provider = new OllamaEmbeddingProvider(model, dimensions, ollamaUrl);
  } else {
    _provider = new OpenAIEmbeddingProvider(model, dimensions);
  }

  return _provider;
}

/** Reset the cached provider (useful when config changes). */
export function resetProvider(): void {
  _provider = null;
}

export async function embed(texts: string | string[]): Promise<number[][]> {
  const input = (Array.isArray(texts) ? texts : [texts]).map(sanitize);
  return getProvider().embed(input);
}

export async function embedSingle(text: string): Promise<number[]> {
  return getProvider().embedSingle(sanitize(text));
}
