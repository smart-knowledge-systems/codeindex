interface LogEvent {
  event: string;
  duration_ms?: number;
  [key: string]: unknown;
}

const ENABLED = process.env.CODEINDEX_LOG_EVENTS === "1";

export function logEvent(event: LogEvent): void {
  if (!ENABLED) return;
  const entry = { ts: new Date().toISOString(), ...event };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export function withTiming<T>(event: string, extra: Record<string, unknown>, fn: () => T): T {
  if (!ENABLED) return fn();
  const start = performance.now();
  const result = fn();
  if (result instanceof Promise) {
    return result.then(
      (v) => {
        logEvent({ event, duration_ms: Math.round(performance.now() - start), ...extra });
        return v;
      },
      (err) => {
        logEvent({
          event,
          duration_ms: Math.round(performance.now() - start),
          error: true,
          ...extra,
        });
        throw err;
      },
    ) as T;
  }
  logEvent({ event, duration_ms: Math.round(performance.now() - start), ...extra });
  return result;
}
