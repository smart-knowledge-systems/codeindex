import path from "path";
import os from "os";
import { hasFlag, type ParsedArgs } from "../cli";
import { resetTelemetry } from "../telemetry";

export async function cmdTelemetry(parsed: ParsedArgs) {
  if (hasFlag(parsed, "reset")) {
    await resetTelemetry();
    console.log("Telemetry data reset.");
    return;
  }
  const telemetryFile = path.join(
    process.env.HOME ?? os.homedir(),
    ".config",
    "codeindex",
    "telemetry.jsonl",
  );
  try {
    const content = await Bun.file(telemetryFile).text();
    if (!content.trim()) {
      console.log("No telemetry data recorded. Set CODEINDEX_TELEMETRY=1 to enable.");
      return;
    }
    console.log(content);
  } catch {
    console.log("No telemetry data found. Set CODEINDEX_TELEMETRY=1 to enable.");
  }
}
