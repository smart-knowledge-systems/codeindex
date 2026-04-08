// ---------------------------------------------------------------------------
// Shared API types — used by both worker/ and the CLI client
// Zod schemas define the source of truth; TS types are inferred from them.
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// Cloud User
// ---------------------------------------------------------------------------

export const CloudUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  plan: z.string(),
});
export type CloudUser = z.infer<typeof CloudUserSchema>;

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export const IngestBeginParamsSchema = z.object({
  repo: z.string().optional(),
  hashes: z.array(z.string()).optional(),
});
export type IngestBeginParams = z.infer<typeof IngestBeginParamsSchema>;

export const IngestBeginResultSchema = z.object({
  jobId: z.string(),
  known_hashes: z.array(z.string()),
});
export type IngestBeginResult = z.infer<typeof IngestBeginResultSchema>;

export const IngestBatchFileSchema = z.object({
  contentHash: z.string(),
  path: z.string(),
  skeleton: z.string(),
  skeletonEntries: z.string().nullable(),
  fileType: z.string(),
  importEdges: z
    .array(
      z.object({
        specifier: z.string(),
        kind: z.string(),
      }),
    )
    .nullable(),
});
export type IngestBatchFile = z.infer<typeof IngestBatchFileSchema>;

export const IngestBatchParamsSchema = z.object({
  jobId: z.string(),
  files: z.array(IngestBatchFileSchema),
});
export type IngestBatchParams = z.infer<typeof IngestBatchParamsSchema>;

export const IngestBatchResultSchema = z.object({
  embedded: z.number(),
  skipped: z.number(),
});
export type IngestBatchResult = z.infer<typeof IngestBatchResultSchema>;

export const IngestCompleteParamsSchema = z.object({
  jobId: z.string(),
});
export type IngestCompleteParams = z.infer<typeof IngestCompleteParamsSchema>;

export const IngestCompleteResultSchema = z.object({
  cost_usd: z.number(),
  files_indexed: z.number(),
});
export type IngestCompleteResult = z.infer<typeof IngestCompleteResultSchema>;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const SearchParamsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
});
export type SearchParams = z.infer<typeof SearchParamsSchema>;

export const SearchResultSchema = z.object({
  path: z.string(),
  language: z.string(),
  contentHash: z.string(),
  score: z.number(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const StatusResultSchema = z.object({
  user: CloudUserSchema,
  repos: z.number(),
  files_indexed: z.number(),
  usage: z.object({
    embeddings: z.number(),
    storage_mb: z.number(),
  }),
});
export type StatusResult = z.infer<typeof StatusResultSchema>;

// ---------------------------------------------------------------------------
// Migrate
// ---------------------------------------------------------------------------

export const MigrateParamsSchema = z.object({
  files: z.array(IngestBatchFileSchema),
});
export type MigrateParams = z.infer<typeof MigrateParamsSchema>;

export const MigrateResultSchema = z.object({
  imported: z.number(),
  skipped: z.number(),
  total: z.number(),
});
export type MigrateResult = z.infer<typeof MigrateResultSchema>;

// ---------------------------------------------------------------------------
// Auth (request/response shapes)
// ---------------------------------------------------------------------------

export const AuthExchangeParamsSchema = z.object({
  session_token: z.string().min(1),
});
export type AuthExchangeParams = z.infer<typeof AuthExchangeParamsSchema>;

export const AuthExchangeResultSchema = z.object({
  token: z.string(),
  user: CloudUserSchema,
});
export type AuthExchangeResult = z.infer<typeof AuthExchangeResultSchema>;
