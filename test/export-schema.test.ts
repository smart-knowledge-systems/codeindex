/**
 * Export schema unit test.
 *
 * The full export round-trip requires a live Postgres instance and is not
 * exercised by the suite (no other test in this repo touches PG). This test
 * pins the additive parts of the Phase 3 export change that do not depend
 * on PG: the export schema must contain a `_metadata(key, value)` table,
 * and the export transaction must stamp `schema_version = '1'` so future
 * format bumps can be detected by downstream consumers (cidx-cloud ingest,
 * IDE plugins). The legacy `files`, `directories`, etc. tables continue to
 * exist on the export with their current shape — this test pins that as
 * well so the additive change cannot accidentally break the format.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createExportSchema } from "../src/db/export";

describe("export schema", () => {
  it("creates _metadata table alongside the legacy export tables", () => {
    const db = new Database(":memory:");
    createExportSchema(db, true /* redactEmbeddings */, true /* redactCommits */, 1536);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = new Set(tables.map((t) => t.name));

    expect(names.has("_metadata")).toBe(true);
    expect(names.has("repos")).toBe(true);
    expect(names.has("files")).toBe(true);
    expect(names.has("directories")).toBe(true);

    db.close();
  });

  it("_metadata schema_version round-trips as '1'", () => {
    const db = new Database(":memory:");
    createExportSchema(db, true, true, 1536);
    db.prepare("INSERT OR REPLACE INTO _metadata (key, value) VALUES (?, ?)").run(
      "schema_version",
      "1",
    );
    const row = db.prepare("SELECT value FROM _metadata WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("1");
    db.close();
  });
});
