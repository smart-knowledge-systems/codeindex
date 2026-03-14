import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic();
  }
  return _client;
}

export async function generateSummary(
  prompt: string,
  model = "claude-haiku-4-5-20251001",
): Promise<{
  summary: string;
  tokensIn: number;
  tokensOut: number;
}> {
  const client = getClient();
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const summary = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    summary,
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
  };
}

export async function generateSummariesBatch(
  prompts: Array<{ id: string; prompt: string }>,
  model = "claude-haiku-4-5-20251001",
): Promise<Map<string, { summary: string; tokensIn: number; tokensOut: number }>> {
  const client = getClient();

  const batch = await client.messages.batches.create({
    requests: prompts.map((p) => ({
      custom_id: p.id,
      params: {
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: p.prompt }],
      },
    })),
  });

  // Poll for completion
  const results = new Map<string, { summary: string; tokensIn: number; tokensOut: number }>();
  let status = batch;
  const maxWaitMs = 30 * 60 * 1000; // 30 minutes
  const startTime = Date.now();
  let pollIntervalMs = 5_000;
  const MAX_POLL_INTERVAL_MS = 60_000;
  while (status.processing_status === "in_progress") {
    if (Date.now() - startTime > maxWaitMs) {
      try {
        await client.messages.batches.cancel(batch.id);
      } catch {
        /* best-effort cancellation */
      }
      throw new Error(`Batch ${batch.id} did not complete within 30 minutes (cancelled)`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    pollIntervalMs = Math.min(pollIntervalMs * 1.5, MAX_POLL_INTERVAL_MS);
    status = await client.messages.batches.retrieve(batch.id);
  }

  // Fetch results
  const resultsStream = await client.messages.batches.results(batch.id);
  for await (const result of resultsStream) {
    if (result.result.type === "succeeded") {
      const msg = result.result.message;
      const summary = msg.content
        .filter((b) => b.type === "text")
        .map((b) => ("text" in b ? b.text : ""))
        .join("");
      results.set(result.custom_id, {
        summary,
        tokensIn: msg.usage.input_tokens,
        tokensOut: msg.usage.output_tokens,
      });
    } else {
      console.error(
        `Batch item ${result.custom_id} failed: ${result.result.type}`,
        result.result.type === "errored" ? result.result.error : undefined,
      );
    }
  }

  return results;
}
