import path from "path";
import { appendFile, mkdir } from "fs/promises";
import crypto from "crypto";

const TELEMETRY_DIR = path.join(process.env.HOME ?? "~", ".config", "codeindex");
const TELEMETRY_FILE = path.join(TELEMETRY_DIR, "telemetry.jsonl");
const ENABLED = process.env.CODEINDEX_TELEMETRY === "1";

export interface TelemetryEvent {
  event: string;
  timestamp: string;
  [key: string]: unknown;
}

let _dirEnsured = false;

async function ensureDir(): Promise<void> {
  if (_dirEnsured) return;
  await mkdir(TELEMETRY_DIR, { recursive: true });
  _dirEnsured = true;
}

export async function recordEvent(event: TelemetryEvent): Promise<void> {
  if (!ENABLED) return;
  try {
    await ensureDir();
    await appendFile(TELEMETRY_FILE, JSON.stringify(event) + "\n");
  } catch {
    // Silently ignore telemetry write failures
  }
}

export function hashQuery(query: string): string {
  return crypto.createHash("sha256").update(query).digest("hex").slice(0, 16);
}

export async function resetTelemetry(): Promise<void> {
  try {
    await Bun.write(TELEMETRY_FILE, "");
  } catch {
    // ignore
  }
}

export function isTelemetryEnabled(): boolean {
  return ENABLED;
}
