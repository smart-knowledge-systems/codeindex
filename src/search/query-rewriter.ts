import type { SearchOptions } from "./types";

export interface QueryRewriteContext {
  /** Last N queries in the current session (most recent last). */
  sessionQueries: string[];
}

/**
 * Session-aware query rewriter.
 * TODO: Implement when telemetry gate passes (50+ search events, 10+ sessions with 3+ sequential queries).
 * Rules-based follow-up detection:
 * - Short query + pronoun ("it", "that", "this") → prepend previous query context
 * - High term overlap with previous query → treat as refinement
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
export function rewriteQuery(
  query: string,
  _ctx: QueryRewriteContext,
  _opts?: SearchOptions,
): string {
  /* eslint-enable @typescript-eslint/no-unused-vars */
  // Passthrough — telemetry gate not met
  return query;
}
