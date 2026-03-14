import OpenAI from "openai";
import type { EmbeddingProvider } from "../embedding-provider";
import { recordCost } from "../../cost";

const BATCH_SIZE = 2048;
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
      return response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
    } catch (err) {
      const isRateLimit = err instanceof OpenAI.APIError && err.status === 429;
      if (isRateLimit && attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.embedBatch(texts, attempt + 1);
      }
      throw err;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length <= BATCH_SIZE) {
      return this.embedBatch(texts);
    }
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const chunk = texts.slice(i, i + BATCH_SIZE);
      const chunkResults = await this.embedBatch(chunk);
      results.push(...chunkResults);
    }
    return results;
  }

  async embedSingle(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0];
  }
}
