/**
 * Unit test for the pure junction-query builder used by the
 * `useBlobSchema` PG search path. No DB connection — just verifies the
 * generated SQL + bind params for the expected filter combinations.
 */

import { describe, it, expect } from "bun:test";
import { buildBlobFileQuery } from "../src/search/search-pg";

const VEC = `'[0.1,0.2]'::vector`;

describe("buildBlobFileQuery", () => {
  it("emits a base join with repo scope and embedding-not-null guard", () => {
    const { sql, params } = buildBlobFileQuery({
      repoIds: [1, 2],
      vecLiteral: VEC,
      langExts: null,
      dirFilters: null,
      sinceIso: null,
    });
    expect(params).toEqual([]);
    expect(sql).toContain("FROM file_blobs fb");
    expect(sql).toContain("JOIN repo_files rf");
    expect(sql).toContain("rf.content_hash = fb.content_hash");
    expect(sql).toContain("rf.repo_id IN (1,2)");
    expect(sql).toContain("fb.embedding IS NOT NULL");
    expect(sql).toContain(`1 - (fb.embedding <=> ${VEC}) AS similarity`);
  });

  it("filters file_type on the blob row when langExts is provided", () => {
    const { sql, params } = buildBlobFileQuery({
      repoIds: [7],
      vecLiteral: VEC,
      langExts: ["ts", "tsx"],
      dirFilters: null,
      sinceIso: null,
    });
    expect(params).toEqual(["ts", "tsx"]);
    expect(sql).toContain("fb.file_type IN ($1,$2)");
  });

  it("filters file_path on the junction row when dirFilters is provided", () => {
    const { sql, params } = buildBlobFileQuery({
      repoIds: [7],
      vecLiteral: VEC,
      langExts: null,
      dirFilters: ["src/", "test"],
      sinceIso: null,
    });
    expect(params).toEqual(["src/%", "test/%"]);
    expect(sql).toContain("rf.file_path LIKE $1");
    expect(sql).toContain("rf.file_path LIKE $2");
  });

  it("preserves legacy commit-authored-at semantics for the since filter", () => {
    const iso = "2026-01-01T00:00:00.000Z";
    const { sql, params } = buildBlobFileQuery({
      repoIds: [1],
      vecLiteral: VEC,
      langExts: null,
      dirFilters: null,
      sinceIso: iso,
    });
    expect(params).toEqual([iso]);
    expect(sql).toContain("EXISTS (SELECT 1 FROM files f");
    expect(sql).toContain("JOIN file_commits fc");
    expect(sql).toContain("c.authored_at >= $1");
    expect(sql).toContain("f.repo_id = rf.repo_id AND f.file_path = rf.file_path");
  });

  it("composes lang + dir + since filters with sequential bind indexes", () => {
    const iso = "2026-01-01T00:00:00.000Z";
    const { sql, params } = buildBlobFileQuery({
      repoIds: [1, 2, 3],
      vecLiteral: VEC,
      langExts: ["ts"],
      dirFilters: ["src/"],
      sinceIso: iso,
    });
    expect(params).toEqual(["ts", "src/%", iso]);
    expect(sql).toContain("fb.file_type IN ($1)");
    expect(sql).toContain("rf.file_path LIKE $2");
    expect(sql).toContain("c.authored_at >= $3");
  });

  it("rejects non-integer repo IDs to prevent SQL injection", () => {
    expect(() =>
      buildBlobFileQuery({
        repoIds: [1, 2.5],
        vecLiteral: VEC,
        langExts: null,
        dirFilters: null,
        sinceIso: null,
      }),
    ).toThrow(/Invalid repo ID/);
  });
});
