import type { EmbeddingProvider } from "../embedding-provider";
import { recordCost } from "../../cost";

const BATCH_SIZE = 64; // Ollama typically handles smaller batches
const MAX_RETRIES = 3;

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private baseUrl: string;

  constructor(model = "nomic-embed-text", dimensions = 768, baseUrl = "http://localhost:11434") {
    this.name = model;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async embedBatch(texts: string[], attempt = 0): Promise<number[][]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.name, input: texts }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as { embeddings: number[][] };

      // Record approximate cost (local model = 0 cost, but track token usage)
      const approxTokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
      await recordCost("embed", this.name, approxTokens, 0);

      return data.embeddings;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
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

  /** Check if the Ollama server is reachable and the model is available. */
  async checkAvailability(): Promise<{ available: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        return { available: false, error: `Ollama server returned ${response.status}` };
      }
      const data = (await response.json()) as { models: { name: string }[] };
      const modelNames = data.models.map((m) => m.name);
      const found = modelNames.some((n) => n === this.name || n.startsWith(`${this.name}:`));
      if (!found) {
        return {
          available: false,
          error: `Model "${this.name}" not found. Run: ollama pull ${this.name}`,
        };
      }
      return { available: true };
    } catch {
      return { available: false, error: `Cannot connect to Ollama at ${this.baseUrl}` };
    }
  }
}
