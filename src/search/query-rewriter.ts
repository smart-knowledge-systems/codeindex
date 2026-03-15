import type { SearchOptions } from "./types";

export interface QueryRewriteContext {
  /** Last N queries in the current session (most recent last). */
  sessionQueries: string[];
}

/**
 * Session-aware query rewriter.
 * Currently a passthrough — telemetry gate not yet met
 * (requires 50+ search events, 10+ sessions with 3+ sequential queries).
 *
 * When enabled, will implement rules-based follow-up detection:
 * - Short query + pronoun ("it", "that", "this") → prepend previous query context
 * - High term overlap with previous query → treat as refinement
 */
export function rewriteQuery(
  query: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ctx: QueryRewriteContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _opts?: SearchOptions,
): string {
  return query;
}
