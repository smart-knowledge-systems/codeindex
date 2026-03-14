import type { EmbeddingProvider } from "./embedding-provider";
import type { CodeindexConfig } from "../search/types";
import { OpenAIEmbeddingProvider } from "./providers/openai";
import { OllamaEmbeddingProvider } from "./providers/ollama";
import { logEvent } from "../logging";

const MAX_EMBED_CHARS = 4_000; // ~8000 tokens max; code averages ~2 tokens/char

function sanitize(text: string): string {
  if (text.length === 0) return " ";
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

const _providers = new Map<string, EmbeddingProvider>();
const DEFAULT_KEY = "openai:text-embedding-3-small:1536:";

/** Get or create the configured embedding provider. */
export function getProvider(config?: CodeindexConfig): EmbeddingProvider {
  if (!config) {
    const cached = _providers.get(DEFAULT_KEY);
    if (cached) return cached;
    const p = new OpenAIEmbeddingProvider();
    _providers.set(DEFAULT_KEY, p);
    return p;
  }

  const { provider, model, dimensions, ollamaUrl } = config.embedding;
  const key = `${provider}:${model}:${dimensions}:${ollamaUrl ?? ""}`;

  const cached = _providers.get(key);
  if (cached) return cached;

  const p =
    provider === "ollama"
      ? new OllamaEmbeddingProvider(model, dimensions, ollamaUrl)
      : new OpenAIEmbeddingProvider(model, dimensions);
  _providers.set(key, p);

  return p;
}

/** Reset all cached providers. */
export function resetProvider(): void {
  _providers.clear();
}

export async function embed(
  texts: string | string[],
  config?: CodeindexConfig,
): Promise<number[][]> {
  const input = (Array.isArray(texts) ? texts : [texts]).map(sanitize);
  const result = await getProvider(config).embed(input);
  logEvent({ event: "embed", text_count: input.length });
  return result;
}

export async function embedSingle(text: string, config?: CodeindexConfig): Promise<number[]> {
  return getProvider(config).embedSingle(sanitize(text));
}
