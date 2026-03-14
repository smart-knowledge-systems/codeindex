import type { SearchResult } from "./types";

export interface ClusterResult {
  cluster: string;
  clusterLabel: string;
}

/**
 * Group search results by directory prefix, language, or cross-repo connectivity.
 * TODO: Implement when telemetry gate passes (20+ cross-repo searches with >10 results).
 * Planned grouping strategies:
 * - Common directory path prefix (longest common ancestor)
 * - Language
 * - Cross-repo edge connectivity
 * - Assign labels like "Authentication (src/auth/)"
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function clusterResults(_results: SearchResult[]): Map<number, ClusterResult> {
  // Passthrough — telemetry gate not met
  return new Map();
}
