import type { EmbeddingProvider } from "../embedding-provider";

// Remote embedding API batch size — conservative default; remote servers vary in capacity
const BATCH_SIZE = 128;
const MAX_RETRIES = 3;

interface RemoteEmbedResponse {
  embeddings: number[][];
}

export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private endpointUrl: string;
  private authToken: string | undefined;

  constructor(
    model = "remote",
    dimensions = 1536,
    endpointUrl = "http://localhost:8080/embed",
    authToken?: string,
  ) {
    this.name = model;
    this.dimensions = dimensions;
    this.endpointUrl = endpointUrl;
    this.authToken = authToken;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }
    return headers;
  }

  private async embedBatch(texts: string[], attempt = 0): Promise<number[][]> {
    try {
      const response = await fetch(this.endpointUrl, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({ texts }),
      });

      if (response.status === 429 && attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.embedBatch(texts, attempt + 1);
      }

      if (!response.ok) {
        throw new Error(`Remote embedding API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as RemoteEmbedResponse;
      return data.embeddings;
    } catch (err) {
      // Retry on network errors (not on HTTP errors already thrown above)
      if (
        attempt < MAX_RETRIES &&
        err instanceof TypeError // fetch network errors are TypeErrors
      ) {
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
