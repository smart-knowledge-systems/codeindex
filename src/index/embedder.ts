import OpenAI from "openai";
import { recordCost } from "../cost";

const MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;
const BATCH_SIZE = 2048;
const MAX_RETRIES = 3;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI();
  }
  return client;
}

const MAX_EMBED_CHARS = 4_000; // ~8000 tokens max; code averages ~2 tokens/char

function sanitize(text: string): string {
  if (text.length === 0) return " ";
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

async function embedBatch(texts: string[], attempt = 0): Promise<number[][]> {
  try {
    const response = await getClient().embeddings.create({
      model: MODEL,
      dimensions: DIMENSIONS,
      input: texts,
    });
    // Record cost from usage
    if (response.usage?.total_tokens) {
      await recordCost("embed", MODEL, response.usage.total_tokens, 0);
    }
    return response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  } catch (err) {
    const isRateLimit = err instanceof OpenAI.APIError && err.status === 429;
    if (isRateLimit && attempt < MAX_RETRIES) {
      const delay = 1000 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return embedBatch(texts, attempt + 1);
    }
    throw err;
  }
}

export async function embed(texts: string | string[]): Promise<number[][]> {
  const input = (Array.isArray(texts) ? texts : [texts]).map(sanitize);

  if (input.length <= BATCH_SIZE) {
    return embedBatch(input);
  }

  const results: number[][] = [];
  for (let i = 0; i < input.length; i += BATCH_SIZE) {
    const chunk = input.slice(i, i + BATCH_SIZE);
    const chunkResults = await embedBatch(chunk);
    results.push(...chunkResults);
  }
  return results;
}

export async function embedSingle(text: string): Promise<number[]> {
  const results = await embed(text);
  return results[0];
}
