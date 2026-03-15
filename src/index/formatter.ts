import { logEvent } from "../logging";

export function hashContent(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

export async function formatAndHash(
  content: string,
  formatterCmd: string | null,
): Promise<{ formatted: string; hash: string }> {
  if (!formatterCmd) {
    return { formatted: content, hash: hashContent(content) };
  }

  try {
    const proc = Bun.spawn(formatterCmd.split(" "), {
      stdin: new Response(content),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      logEvent({
        event: "index.format.error",
        "error.type": "nonzero_exit",
        "error.code": exitCode,
      });
      return { formatted: content, hash: hashContent(content) };
    }

    const formatted = await new Response(proc.stdout).text();
    return { formatted, hash: hashContent(formatted) };
  } catch (err) {
    logEvent({
      event: "index.format.error",
      "error.type": "process_failure",
      "error.message": err instanceof Error ? err.message : String(err),
    });
    return { formatted: content, hash: hashContent(content) };
  }
}
