/**
 * Unit tests for the SQLite junction-based file query builder.
 * Mirrors the PG buildBlobFileQuery tests.
 */

import { describe, it, expect } from "bun:test";
import { buildBlobFileQuerySqlite } from "../src/search/search-sqlite";

describe("buildBlobFileQuerySqlite", () => {
  it("builds a base query with no filters", () => {
    const { sql, params } = buildBlobFileQuerySqlite({
      repoIds: [1, 2],
      langExts: null,
      dirFilters: null,
      sinceIso: null,
    });

    expect(sql).toContain("FROM file_blob_embeddings fbe");
    expect(sql).toContain("JOIN file_blobs fb ON fb.blob_id = fbe.blob_id");
    expect(sql).toContain("JOIN repo_files rf");
    expect(sql).toContain("rf.repo_id IN (1,2)");
    expect(sql).toContain("fbe.embedding MATCH ?");
    expect(sql).toContain("fbe.k = ?");
    expect(params).toEqual([]);
  });

  it("appends lang, dir, and since filters with bind params", () => {
    const { sql, params } = buildBlobFileQuerySqlite({
      repoIds: [7],
      langExts: ["ts", "tsx"],
      dirFilters: ["src/", "lib"],
      sinceIso: "2026-01-01T00:00:00.000Z",
    });

    expect(sql).toContain("fb.file_type IN (?,?)");
    expect(sql).toContain("rf.file_path LIKE ?");
    expect(sql).toContain(
      "EXISTS (SELECT 1 FROM files f JOIN file_commits fc ON fc.file_id = f.id",
    );
    expect(params).toEqual([
      "ts",
      "tsx",
      "src/%",
      "lib/%",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("rejects non-integer repo ids", () => {
    expect(() =>
      buildBlobFileQuerySqlite({
        repoIds: [1.5],
        langExts: null,
        dirFilters: null,
        sinceIso: null,
      }),
    ).toThrow(/Invalid repo ID/);
  });
});
