import OpenAI from "openai";
import type { EmbeddingProvider } from "../embedding-provider";
import { recordCost } from "../../cost";
import { logEvent } from "../../logging";

// OpenAI embeddings API has a 300K token-per-request limit.
// We batch by both item count and estimated token budget.
const MAX_BATCH_ITEMS = 256;
const MAX_BATCH_TOKENS = 250_000; // stay under 300K with headroom
const CHARS_PER_TOKEN = 2; // code averages ~2 chars per token
const MAX_RETRIES = 6;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private client: OpenAI | null = null;

  constructor(model = "text-embedding-3-small", dimensions = 1536) {
    this.name = model;
    this.dimensions = dimensions;
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI();
    }
    return this.client;
  }

  private async embedBatch(texts: string[], attempt = 0): Promise<number[][]> {
    try {
      const response = await this.getClient().embeddings.create({
        model: this.name,
        dimensions: this.dimensions,
        input: texts,
      });
      if (response.usage?.total_tokens) {
        await recordCost("embed", this.name, response.usage.total_tokens, 0);
      }

      logEvent({
        event: "infra.embed.batch_complete",
        provider: this.name,
        text_count: texts.length,
      });

      const embeddings = new Array<number[]>(response.data.length);
      for (const item of response.data) {
        embeddings[item.index] = item.embedding;
      }
      return embeddings;
    } catch (err) {
      const isRetriable =
        err instanceof OpenAI.APIError && (err.status === 429 || (err.status ?? 0) >= 500);
      if (isRetriable && attempt < MAX_RETRIES) {
        // Respect Retry-After header if present, otherwise exponential backoff with jitter
        let delay: number;
        const retryAfter =
          err instanceof OpenAI.APIError ? (err.headers?.["retry-after"] ?? null) : null;
        if (retryAfter) {
          const parsed = parseFloat(retryAfter);
          delay = Number.isFinite(parsed) ? parsed * 1000 : BACKOFF_BASE_MS * Math.pow(2, attempt);
        } else {
          delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        }
        // Add jitter: ±25% randomization
        delay *= 0.75 + Math.random() * 0.5;
        delay = Math.min(delay, BACKOFF_MAX_MS);

        const errorType =
          err instanceof OpenAI.APIError && err.status === 429 ? "rate_limit" : "server_error";
        logEvent({
          event: "infra.embed.retry",
          provider: this.name,
          attempt: attempt + 1,
          delay_ms: Math.round(delay),
          "error.type": errorType,
          "error.message": err instanceof Error ? err.message : String(err),
        });
        process.stderr.write(
          `  Rate limited — retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_RETRIES})\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.embedBatch(texts, attempt + 1);
      }
      logEvent({
        event: "infra.embed.failed",
        provider: this.name,
        "error.type":
          err instanceof OpenAI.APIError && err.status === 429
            ? "rate_limit"
            : err instanceof Error
              ? err.constructor.name
              : "unknown",
        "error.message": err instanceof Error ? err.message : String(err),
        "error.retriable": false,
      });
      throw err;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const batches: string[][] = [];
    let current: string[] = [];
    let currentTokens = 0;

    for (const text of texts) {
      const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
      if (
        current.length > 0 &&
        (current.length >= MAX_BATCH_ITEMS || currentTokens + estimatedTokens > MAX_BATCH_TOKENS)
      ) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(text);
      currentTokens += estimatedTokens;
    }
    if (current.length > 0) batches.push(current);

    const results: number[][] = [];
    for (const batch of batches) {
      results.push(...(await this.embedBatch(batch)));
    }
    return results;
  }

  async embedSingle(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0];
  }
}
