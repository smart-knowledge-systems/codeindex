import {
  initLogging,
  logEvent,
  setCorrelationContext,
  getSessionId,
  hashPath,
  withTimingSync,
  withTimingAsync,
} from "@easier-idx/logging";

// Initialize with codeindex domains + env var
initLogging({
  domains: [
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
    "embed",
  ],
  envVar: "CODEINDEX_LOG_EVENTS",
});

// Re-export everything for existing consumers
export { logEvent, setCorrelationContext, getSessionId, hashPath, withTimingSync, withTimingAsync };
