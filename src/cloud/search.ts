// Cloud search command

import { flag, hasFlag, type ParsedArgs } from "../cli";
import { CloudClient, type SearchResult } from "./client";
import { formatError } from "../errors";

function formatPretty(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.\n";

  // Group by repo if results span multiple repos
  const lines: string[] = [];
  for (const r of results) {
    const score = r.score.toFixed(4);
    lines.push(`  ${r.path}  (${r.language})  score=${score}`);
  }
  return lines.join("\n") + "\n";
}

export async function cloudSearch(parsed: ParsedArgs): Promise<void> {
  const client = new CloudClient();
  await client.loadCredentials();

  if (!client.isAuthenticated()) {
    process.stderr.write("Not logged in. Run `cidx cloud login` to authenticate.\n");
    process.exit(1);
  }

  // positional[0] = "search" subcommand, positional[1] = query
  const query = parsed.positional[1];
  if (!query) {
    process.stderr.write("Usage: cidx cloud search <query> [--top N] [--json] [--pretty]\n");
    process.exit(1);
  }

  const topN = flag(parsed, "top");
  const limit = topN ? parseInt(topN, 10) : undefined;

  try {
    const results = await client.search({ query, limit });

    if (hasFlag(parsed, "json")) {
      process.stdout.write(JSON.stringify(results, null, 2) + "\n");
      return;
    }

    process.stdout.write(formatPretty(results));
  } catch (err) {
    process.stderr.write(`Cloud search failed: ${formatError(err)}\n`);
    process.exit(1);
  }
}
