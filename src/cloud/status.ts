// Cloud status command

import { hasFlag, type ParsedArgs } from "../cli";
import { CloudClient } from "./client";
import { formatError } from "../errors";

export async function cloudStatus(parsed: ParsedArgs): Promise<void> {
  const client = new CloudClient();
  await client.loadCredentials();

  if (!client.isAuthenticated()) {
    process.stderr.write("Not logged in. Run `cidx cloud login` to authenticate.\n");
    process.exit(1);
  }

  try {
    const status = await client.getStatus();

    if (hasFlag(parsed, "json")) {
      process.stdout.write(JSON.stringify(status, null, 2) + "\n");
      return;
    }

    process.stderr.write(`User:    ${status.user.name} (${status.user.email})\n`);
    process.stderr.write(`Plan:    ${status.user.plan}\n`);
    process.stderr.write(`Repos:   ${status.repos}\n`);
    process.stderr.write(`Files:   ${status.files_indexed}\n`);
    process.stderr.write(`Usage:\n`);
    process.stderr.write(`  Embeddings: ${status.usage.embeddings}\n`);
    process.stderr.write(`  Storage:    ${status.usage.storage_mb} MB\n`);
  } catch (err) {
    process.stderr.write(`Cloud status failed: ${formatError(err)}\n`);
    process.exit(1);
  }
}
