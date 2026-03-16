import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Correlation context — every log event must carry these for traceability
// ---------------------------------------------------------------------------

interface CorrelationContext {
  sessionId: string;
  repoId?: number;
}

// Process-level session ID, generated once per CLI invocation
const SESSION_ID = createHash("sha256")
  .update(`${process.pid}-${Date.now()}-${Math.random()}`)
  .digest("hex")
  .slice(0, 16);

let globalCorrelation: CorrelationContext = { sessionId: SESSION_ID };

export function setCorrelationContext(ctx: Partial<CorrelationContext>): void {
  globalCorrelation = { ...globalCorrelation, ...ctx };
}

export function getSessionId(): string {
  return SESSION_ID;
}

// ---------------------------------------------------------------------------
// Path hashing — avoid logging raw file system paths (PII-adjacent)
// ---------------------------------------------------------------------------

export function hashPath(p: string): string {
  return createHash("sha256").update(p).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Structured log events (domain.action naming, correlation IDs required)
// ---------------------------------------------------------------------------

/** Valid event domains per the logging strategy. */
const VALID_DOMAINS = new Set([
  "reading",
  "sync",
  "orientation",
  "cdn",
  "auth",
  "infra",
  "web",
  "index",
  "check",
  "pipeline",
  "search",
  "mcp",
  "cost",
]);

interface LogEvent {
  event: string;
  duration_ms?: number;
  sessionId?: string;
  repoId?: number;
  [key: string]: unknown;
}

/** Structured error fields following logging strategy Rule 10. */
interface StructuredError {
  "error.type": string;
  "error.message": string;
  "error.retriable"?: boolean;
}

const ENABLED = process.env.CODEINDEX_LOG_EVENTS === "1";

/**
 * Validate that event name follows domain.action format.
 * Returns true if valid, false otherwise.
 */
function isValidEventName(event: string): boolean {
  const dotIndex = event.indexOf(".");
  if (dotIndex <= 0) return false;
  const domain = event.slice(0, dotIndex);
  return VALID_DOMAINS.has(domain);
}

/**
 * Emit a structured log event with correlation context.
 * Events must use domain.action naming (e.g. "infra.reindex.status").
 * Correlation fields (sessionId, repoId) are injected automatically.
 */
export function logEvent(event: LogEvent): void {
  if (!ENABLED) return;
  if (!isValidEventName(event.event)) return;
  const entry = {
    ts: new Date().toISOString(),
    sessionId: globalCorrelation.sessionId,
    repoId: globalCorrelation.repoId,
    ...event,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// ---------------------------------------------------------------------------
// Timing wrappers — separate sync and async to avoid runtime type checks
// ---------------------------------------------------------------------------

/** Build structured error fields from a caught value. */
function toStructuredError(err: unknown): StructuredError {
  if (err instanceof Error) {
    return {
      "error.type": err.constructor.name,
      "error.message": err.message,
    };
  }
  return {
    "error.type": "Unknown",
    "error.message": String(err),
  };
}

/**
 * Measure and log the duration of a synchronous operation.
 * On error, logs structured error fields before re-throwing.
 */
export function withTimingSync<T>(event: string, extra: Record<string, unknown>, fn: () => T): T {
  if (!ENABLED) return fn();
  const start = performance.now();
  try {
    const result = fn();
    logEvent({ event, duration_ms: Math.round(performance.now() - start), ...extra });
    return result;
  } catch (err) {
    logEvent({
      event,
      duration_ms: Math.round(performance.now() - start),
      ...extra,
      ...toStructuredError(err),
    });
    throw err;
  }
}

/**
 * Measure and log the duration of an asynchronous operation.
 * On error, logs structured error fields before re-throwing.
 */
export async function withTimingAsync<T>(
  event: string,
  extra: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!ENABLED) return fn();
  const start = performance.now();
  try {
    const result = await fn();
    logEvent({ event, duration_ms: Math.round(performance.now() - start), ...extra });
    return result;
  } catch (err) {
    logEvent({
      event,
      duration_ms: Math.round(performance.now() - start),
      ...extra,
      ...toStructuredError(err),
    });
    throw err;
  }
}
