import OpenAI from "openai";
import type { EmbeddingProvider } from "../embedding-provider";
import { recordCost } from "../../cost";
import { logEvent } from "../../logging";

// OpenAI embeddings API has a 300K token-per-request limit.
// Large skeletons average ~200-500 tokens each, so 256 texts keeps
// us well under the limit while still batching efficiently.
const BATCH_SIZE = 256;
const MAX_RETRIES = 3;

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

      return response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
    } catch (err) {
      const isRateLimit = err instanceof OpenAI.APIError && err.status === 429;
      if (isRateLimit && attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        logEvent({
          event: "infra.embed.retry",
          provider: this.name,
          attempt: attempt + 1,
          delay_ms: delay,
          "error.type": "rate_limit",
          "error.message": err instanceof Error ? err.message : String(err),
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.embedBatch(texts, attempt + 1);
      }
      logEvent({
        event: "infra.embed.failed",
        provider: this.name,
        "error.type": isRateLimit
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
    const batches = Array.from({ length: Math.ceil(texts.length / BATCH_SIZE) }, (_, i) =>
      texts.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE),
    );
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
