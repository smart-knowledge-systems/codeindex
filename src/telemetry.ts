import path from "path";
import { appendFile, mkdir } from "fs/promises";
import crypto from "crypto";
import os from "os";
import { getSessionId } from "./logging";

const TELEMETRY_DIR = path.join(process.env.HOME ?? os.homedir(), ".config", "codeindex");
const TELEMETRY_FILE = path.join(TELEMETRY_DIR, "telemetry.jsonl");
const ENABLED = process.env.CODEINDEX_TELEMETRY === "1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelemetryEvent {
  event: string;
  timestamp: string;
  sessionId: string;
  repoId?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// I/O boundary — file system operations
// ---------------------------------------------------------------------------

let _dirEnsured = false;

async function ensureDir(): Promise<void> {
  if (_dirEnsured) return;
  await mkdir(TELEMETRY_DIR, { recursive: true });
  _dirEnsured = true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a telemetry event with required correlation context.
 * The sessionId is injected automatically from the logging module
 * if not provided by the caller.
 */
export async function recordEvent(event: TelemetryEvent): Promise<void> {
  if (!ENABLED) return;
  const enriched: TelemetryEvent = {
    ...event,
    sessionId: event.sessionId || getSessionId(),
  };
  try {
    await ensureDir();
    await appendFile(TELEMETRY_FILE, JSON.stringify(enriched) + "\n");
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
