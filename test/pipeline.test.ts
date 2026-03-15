import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import path from "path";
import fs from "fs";
import os from "os";
import { initParser } from "../src/index/skeleton";
import { getSqlite, closeSqlite } from "../src/db/sqlite";
import { ensureSqliteSchema } from "../src/db/schema";
import { loadConfig } from "../src/config";
import { collectFiles } from "../src/pipeline/collect";
import { embedFiles } from "../src/pipeline/embed";
import { storeFiles } from "../src/pipeline/store";
import { pruneStale } from "../src/pipeline/prune";
import { indexCommits } from "../src/pipeline/commits";
import { summarizeDirs } from "../src/pipeline/summarize";
import type { PipelineContext, CollectedFile, SummaryProvider } from "../src/pipeline/types";

// ---------------------------------------------------------------------------
// Mock embedding provider — returns deterministic fake vectors.
// Must match the schema dimension (1536) to pass sqlite-vec validation.
// ---------------------------------------------------------------------------

const EMBED_DIM = 1536;

function fakeVector(seed: number): number[] {
  return Array.from({ length: EMBED_DIM }, (_, j) => ((seed + j) % 100) * 0.001);
}

mock.module("../src/index/embedder", () => ({
  embed: async (texts: string | string[]) => {
    const arr = Array.isArray(texts) ? texts : [texts];
    return arr.map((_, i) => fakeVector(i));
  },
  embedSingle: async (_text: string) => fakeVector(0),
  getProvider: () => ({}),
  resetProvider: () => {},
}));

// ---------------------------------------------------------------------------
// Minimal no-op summary provider for tests (avoids calling Anthropic API)
// ---------------------------------------------------------------------------

const noopSummaryProvider: SummaryProvider = {
  name: "noop",
  async summarizeDirectory(_concatSkeleton, _childSummaries) {
    return null;
  },
};

// ---------------------------------------------------------------------------
// Fixture repo setup — create a minimal git repo in a temp directory
// ---------------------------------------------------------------------------

let fixtureRepoRoot: string;
let repoId: number;
let ctx: PipelineContext;

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures");

beforeAll(async () => {
  await initParser();

  // Create a temp directory as the fixture repo
  fixtureRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codeindex-pipeline-test-"));

  // Init git repo
  const gitInit = Bun.spawnSync(["git", "init"], { cwd: fixtureRepoRoot });
  if (gitInit.exitCode !== 0) throw new Error("git init failed");
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: fixtureRepoRoot });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: fixtureRepoRoot });

  // Copy fixture files into the repo
  const fixtureFiles = ["sample.ts", "sample.py", "sample.go"];
  for (const f of fixtureFiles) {
    const src = path.join(FIXTURE_DIR, f);
    const dst = path.join(fixtureRepoRoot, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }

  // Write a .codeindex.json config (sqlite store)
  fs.writeFileSync(
    path.join(fixtureRepoRoot, ".codeindex.json"),
    JSON.stringify({ store: "sqlite" }, null, 2),
  );

  // Commit the fixture files
  Bun.spawnSync(["git", "add", "-A"], { cwd: fixtureRepoRoot });
  Bun.spawnSync(["git", "commit", "-m", "initial commit"], { cwd: fixtureRepoRoot });

  // Init the sqlite schema
  await ensureSqliteSchema(fixtureRepoRoot);

  // Create a repo record
  const db = await getSqlite(fixtureRepoRoot);
  const result = db
    .prepare(
      "INSERT INTO repos (origin_url, root_path, name, formatter_cmd) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .get(null, fixtureRepoRoot, "pipeline-test", null) as { id: number };
  repoId = result.id;

  const config = await loadConfig(fixtureRepoRoot);

  ctx = {
    repoRoot: fixtureRepoRoot,
    repoId,
    config,
    formatter: null,
    store: "sqlite",
    dryRun: false,
    force: false,
  };
});

afterAll(async () => {
  await closeSqlite(fixtureRepoRoot);
  fs.rmSync(fixtureRepoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Stage tests
// ---------------------------------------------------------------------------

describe("collectFiles()", () => {
  it("returns CollectedFile[] for fixture files", async () => {
    const files = await collectFiles(ctx);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.relPath).toBeDefined();
      expect(f.absPath).toBeDefined();
      expect(f.contentHash.length).toBe(64); // sha256 hex
      expect(f.skeleton.length).toBeGreaterThan(0);
      expect(f.fileType).toMatch(/^\./);
    }
  });

  it("collects all files again when force=true", async () => {
    const forceCtx = { ...ctx, force: true };
    const files = await collectFiles(forceCtx);
    expect(files.length).toBeGreaterThan(0);
  });
});

describe("embedFiles()", () => {
  let collectedFiles: CollectedFile[];

  beforeAll(async () => {
    const forceCtx = { ...ctx, force: true };
    collectedFiles = await collectFiles(forceCtx);
  });

  it("returns EmbeddedFile[] with embedding vectors", async () => {
    const embedded = await embedFiles(ctx, collectedFiles);
    expect(embedded.length).toBe(collectedFiles.length);
    for (const f of embedded) {
      expect(Array.isArray(f.embedding)).toBe(true);
      expect(f.embedding.length).toBe(EMBED_DIM);
      expect(typeof f.embedding[0]).toBe("number");
    }
  });

  it("returns empty array for empty input", async () => {
    const embedded = await embedFiles(ctx, []);
    expect(embedded).toEqual([]);
  });
});

describe("storeFiles()", () => {
  it("upserts files and embeddings into SQLite", async () => {
    const forceCtx = { ...ctx, force: true };
    const collected = await collectFiles(forceCtx);
    const embedded = await embedFiles(ctx, collected);
    await storeFiles(ctx, embedded);

    const db = await getSqlite(fixtureRepoRoot);
    const rows = db
      .prepare("SELECT file_path, content_hash FROM files WHERE repo_id = ?")
      .all(repoId) as { file_path: string; content_hash: string }[];

    expect(rows.length).toBeGreaterThan(0);
    const paths = rows.map((r) => r.file_path);
    expect(paths.some((p) => p.endsWith(".ts"))).toBe(true);
  });

  it("stores embeddings in file_embeddings table", async () => {
    const db = await getSqlite(fixtureRepoRoot);
    const rows = db
      .prepare(
        "SELECT fe.file_id FROM file_embeddings fe JOIN files f ON fe.file_id = f.id WHERE f.repo_id = ?",
      )
      .all(repoId) as { file_id: number }[];
    expect(rows.length).toBeGreaterThan(0);
  });

  it("is idempotent — second store doesn't duplicate rows", async () => {
    const forceCtx = { ...ctx, force: true };
    const collected = await collectFiles(forceCtx);
    const embedded = await embedFiles(ctx, collected);
    await storeFiles(ctx, embedded);

    const db = await getSqlite(fixtureRepoRoot);
    const rows = db
      .prepare("SELECT file_path FROM files WHERE repo_id = ?")
      .all(repoId) as { file_path: string }[];

    const uniquePaths = new Set(rows.map((r) => r.file_path));
    expect(uniquePaths.size).toBe(rows.length); // no duplicates
  });

  it("skips files on second collect run (dedup by hash)", async () => {
    // After storeFiles, hashes are in the DB — collect should return 0
    const files = await collectFiles(ctx);
    expect(files.length).toBe(0);
  });
});

describe("pruneStale()", () => {
  it("removes DB rows for files no longer on disk", async () => {
    // Add a phantom file to DB
    const db = await getSqlite(fixtureRepoRoot);
    db.prepare(
      "INSERT INTO files (repo_id, file_path, content_hash, file_type) VALUES (?, ?, ?, ?)",
    ).run(repoId, "ghost/phantom.ts", "abc123", ".ts");

    // Current files — doesn't include the phantom
    const dbRows = db
      .prepare("SELECT file_path FROM files WHERE repo_id = ?")
      .all(repoId) as { file_path: string }[];
    const allPaths = new Set(
      dbRows.map((r) => r.file_path).filter((p) => p !== "ghost/phantom.ts"),
    );

    const pruned = await pruneStale(ctx, allPaths);
    expect(pruned).toBe(1);

    const remaining = db
      .prepare("SELECT file_path FROM files WHERE repo_id = ? AND file_path = ?")
      .all(repoId, "ghost/phantom.ts") as { file_path: string }[];
    expect(remaining.length).toBe(0);
  });

  it("returns 0 when nothing is stale", async () => {
    const db = await getSqlite(fixtureRepoRoot);
    const rows = db
      .prepare("SELECT file_path FROM files WHERE repo_id = ?")
      .all(repoId) as { file_path: string }[];
    const allPaths = new Set(rows.map((r) => r.file_path));

    const pruned = await pruneStale(ctx, allPaths);
    expect(pruned).toBe(0);
  });
});

describe("indexCommits()", () => {
  it("embeds commits and returns a count", async () => {
    const db = await getSqlite(fixtureRepoRoot);
    const fileRows = db
      .prepare("SELECT file_path FROM files WHERE repo_id = ?")
      .all(repoId) as { file_path: string }[];
    const allFiles = fileRows.map((r) => r.file_path);

    const count = await indexCommits(ctx, allFiles);
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("is idempotent — second run returns 0 new commits", async () => {
    const db = await getSqlite(fixtureRepoRoot);
    const fileRows = db
      .prepare("SELECT file_path FROM files WHERE repo_id = ?")
      .all(repoId) as { file_path: string }[];
    const allFiles = fileRows.map((r) => r.file_path);

    const count = await indexCommits(ctx, allFiles);
    expect(count).toBe(0);
  });
});

describe("summarizeDirs()", () => {
  it("runs without error on fixture repo", async () => {
    const db = await getSqlite(fixtureRepoRoot);
    const fileRows = db
      .prepare("SELECT file_path FROM files WHERE repo_id = ?")
      .all(repoId) as { file_path: string }[];
    const allFiles = fileRows.map((r) => r.file_path);

    await expect(summarizeDirs(ctx, allFiles, noopSummaryProvider)).resolves.toBeUndefined();
  });

  it("creates directory rows", async () => {
    const db = await getSqlite(fixtureRepoRoot);
    const rows = db
      .prepare("SELECT dir_path FROM directories WHERE repo_id = ?")
      .all(repoId) as { dir_path: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.dir_path === ".")).toBe(true);
  });
});

describe("pipeline composition", () => {
  it("collect → embed → store produces consistent DB state", async () => {
    const forceCtx = { ...ctx, force: true };
    const collected = await collectFiles(forceCtx);
    expect(collected.length).toBeGreaterThan(0);

    const embedded = await embedFiles(ctx, collected);
    expect(embedded.length).toBe(collected.length);

    await storeFiles(ctx, embedded);

    const db = await getSqlite(fixtureRepoRoot);
    const fileRows = db
      .prepare("SELECT id, file_path, content_hash FROM files WHERE repo_id = ?")
      .all(repoId) as { id: number; file_path: string; content_hash: string }[];

    // Every collected file should be in the DB
    const dbPaths = new Set(fileRows.map((r) => r.file_path));
    for (const f of collected) {
      expect(dbPaths.has(f.relPath)).toBe(true);
    }

    // Every stored file should have an embedding
    for (const row of fileRows) {
      const embRow = db
        .prepare("SELECT file_id FROM file_embeddings WHERE file_id = ?")
        .all(row.id) as { file_id: number }[];
      expect(embRow.length).toBeGreaterThan(0);
    }
  });
});
