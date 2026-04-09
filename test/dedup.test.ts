/**
 * End-to-end test for Phase 1 dependency deduplication.
 *
 * Strategy:
 *   1. Mock the embedder to count calls and return deterministic vectors.
 *   2. Build an in-memory GlobalDedupStore that records writes/lookups.
 *   3. Run collectFiles → embedFiles → storeFiles for fixture repo A.
 *      Confirm every file is a miss and the embedder was called for each.
 *   4. Run the same pipeline against a *fresh* fixture repo B (different
 *      repo root, identical file contents) sharing the same global store.
 *      Confirm every file is a hit and the embedder was called zero times.
 *   5. Sanity-check the tree-hash helper.
 */

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
import type { PipelineContext } from "../src/pipeline/types";
import type {
  GlobalDedupStore,
  BlobKey,
  BlobRecord,
  PackageKey,
  PackageRecord,
  PackageFileEntry,
  PackageMeta,
  DedupStats,
} from "../src/dedup/global-store";
import { treeHash } from "../src/dedup/tree-hash";

// ---------------------------------------------------------------------------
// Embedder mock — counts calls so we can prove the dedup short-circuit works.
// ---------------------------------------------------------------------------

const EMBED_DIM = 1536;
let embedCallCount = 0;
let totalEmbeddings = 0;

function fakeVector(seed: number): number[] {
  return Array.from({ length: EMBED_DIM }, (_, j) => ((seed + j) % 100) * 0.001);
}

mock.module("@easier-idx/embedding", () => ({
  embed: async (_provider: unknown, texts: string | string[]) => {
    const arr = Array.isArray(texts) ? texts : [texts];
    embedCallCount++;
    totalEmbeddings += arr.length;
    return arr.map((_, i) => fakeVector(i));
  },
  embedSingle: async () => fakeVector(0),
}));

mock.module("../src/embedding-provider", () => ({
  getProvider: () => ({}),
  resetProvider: () => {},
}));

// ---------------------------------------------------------------------------
// In-memory GlobalDedupStore — keyed by content_hash + provider/model/dims.
// ---------------------------------------------------------------------------

class InMemoryGlobalStore implements GlobalDedupStore {
  private blobs = new Map<string, BlobRecord>();
  private packages = new Map<string, PackageRecord & PackageKey>();
  private packageFiles = new Map<number, PackageFileEntry[]>();
  private nextPkgId = 1;

  private blobKey(k: BlobKey): string {
    return `${k.contentHash}|${k.provider}|${k.model}|${k.dimensions}`;
  }

  async lookupBlob(key: BlobKey): Promise<BlobRecord | null> {
    return this.blobs.get(this.blobKey(key)) ?? null;
  }

  async lookupBlobs(
    hashes: string[],
    provider: string,
    model: string,
    dimensions: number,
  ): Promise<Map<string, BlobRecord>> {
    const result = new Map<string, BlobRecord>();
    for (const h of hashes) {
      const r = this.blobs.get(this.blobKey({ contentHash: h, provider, model, dimensions }));
      if (r) result.set(h, r);
    }
    return result;
  }

  async writeBlob(key: BlobKey, record: BlobRecord): Promise<void> {
    this.blobs.set(this.blobKey(key), record);
  }

  async lookupPackage(key: PackageKey): Promise<PackageRecord | null> {
    const k = `${key.treeHash}|${key.provider}|${key.model}|${key.dimensions}`;
    return this.packages.get(k) ?? null;
  }

  async listPackageFiles(packageId: number): Promise<PackageFileEntry[]> {
    return this.packageFiles.get(packageId) ?? [];
  }

  async writePackage(
    key: PackageKey,
    meta: PackageMeta,
    files: PackageFileEntry[],
  ): Promise<number> {
    const id = this.nextPkgId++;
    const k = `${key.treeHash}|${key.provider}|${key.model}|${key.dimensions}`;
    this.packages.set(k, { id, ...meta, ...key });
    this.packageFiles.set(id, files);
    return id;
  }

  async linkRepoPackage(): Promise<void> {}

  async stats(): Promise<DedupStats> {
    return { blobCount: this.blobs.size, packageCount: this.packages.size };
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures");
const FIXTURE_FILES = ["sample.ts", "sample.py", "sample.go"];

async function createFixtureRepo(): Promise<{ repoRoot: string; repoId: number }> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codeindex-dedup-test-"));

  Bun.spawnSync(["git", "init"], { cwd: repoRoot });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: repoRoot });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repoRoot });

  for (const f of FIXTURE_FILES) {
    const src = path.join(FIXTURE_DIR, f);
    const dst = path.join(repoRoot, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }

  fs.writeFileSync(
    path.join(repoRoot, ".codeindex.json"),
    JSON.stringify({ store: "sqlite" }, null, 2),
  );
  Bun.spawnSync(["git", "add", "-A"], { cwd: repoRoot });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: repoRoot });

  await ensureSqliteSchema(repoRoot);
  // ensureSqliteSchema caches per-process; closing makes the next repo open fresh
  const db = await getSqlite(repoRoot);
  const result = db
    .prepare(
      "INSERT INTO repos (origin_url, root_path, name, formatter_cmd) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .get(null, repoRoot, "dedup-test", null) as { id: number };
  return { repoRoot, repoId: result.id };
}

async function buildCtx(
  repoRoot: string,
  repoId: number,
  store: GlobalDedupStore,
): Promise<PipelineContext> {
  const config = await loadConfig(repoRoot);
  return {
    repoRoot,
    repoId,
    config,
    formatter: null,
    store: "sqlite",
    dryRun: false,
    force: false,
    globalStore: store,
    dedupStats: { hits: 0, misses: 0 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("treeHash()", () => {
  it("is deterministic regardless of input order", () => {
    const a = treeHash([
      { relpath: "b.txt", contentHash: "deadbeef" },
      { relpath: "a.txt", contentHash: "cafef00d" },
    ]);
    const b = treeHash([
      { relpath: "a.txt", contentHash: "cafef00d" },
      { relpath: "b.txt", contentHash: "deadbeef" },
    ]);
    expect(a).toBe(b);
  });

  it("differs when content changes", () => {
    const a = treeHash([{ relpath: "a.txt", contentHash: "cafef00d" }]);
    const b = treeHash([{ relpath: "a.txt", contentHash: "deadbeef" }]);
    expect(a).not.toBe(b);
  });

  it("differs when filenames change", () => {
    const a = treeHash([{ relpath: "a.txt", contentHash: "deadbeef" }]);
    const b = treeHash([{ relpath: "b.txt", contentHash: "deadbeef" }]);
    expect(a).not.toBe(b);
  });
});

describe("global dedup pipeline", () => {
  let repoARoot: string;
  let repoBRoot: string;

  beforeAll(async () => {
    await initParser();
  });

  afterAll(async () => {
    await closeSqlite();
    if (repoARoot) fs.rmSync(repoARoot, { recursive: true, force: true });
    if (repoBRoot) fs.rmSync(repoBRoot, { recursive: true, force: true });
  });

  it("misses on first repo, hits on second repo with identical content", async () => {
    const globalStore = new InMemoryGlobalStore();

    // --- Repo A: cold start, every file should miss ---
    embedCallCount = 0;
    totalEmbeddings = 0;
    const a = await createFixtureRepo();
    repoARoot = a.repoRoot;
    const ctxA = await buildCtx(a.repoRoot, a.repoId, globalStore);

    const collectedA = await collectFiles(ctxA);
    expect(collectedA.length).toBeGreaterThan(0);
    expect(ctxA.dedupStats!.hits).toBe(0);
    expect(ctxA.dedupStats!.misses).toBe(collectedA.length);

    const embeddedA = await embedFiles(ctxA, collectedA);
    expect(embeddedA.length).toBe(collectedA.length);
    const embedCallsAfterA = embedCallCount;
    const embedsAfterA = totalEmbeddings;
    expect(embedCallsAfterA).toBeGreaterThan(0);
    expect(embedsAfterA).toBe(collectedA.length);

    await storeFiles(ctxA, embeddedA);
    const statsAfterA = await globalStore.stats();
    expect(statsAfterA.blobCount).toBe(collectedA.length);

    // --- Repo B: same fixture content, must be 100% hits ---
    // Force the SQLite singleton to drop repo A's connection so repo B
    // opens its own fresh DB on the next getSqlite() call.
    await closeSqlite();
    const b = await createFixtureRepo();
    repoBRoot = b.repoRoot;
    const ctxB = await buildCtx(b.repoRoot, b.repoId, globalStore);

    const collectedB = await collectFiles(ctxB);
    expect(collectedB.length).toBe(collectedA.length);
    expect(ctxB.dedupStats!.hits).toBe(collectedB.length);
    expect(ctxB.dedupStats!.misses).toBe(0);

    // Every CollectedFile from a hit must carry the cached embedding.
    for (const f of collectedB) {
      expect(f.cachedEmbedding).toBeDefined();
      expect(f.cachedEmbedding!.length).toBe(EMBED_DIM);
    }

    const embeddedB = await embedFiles(ctxB, collectedB);
    expect(embeddedB.length).toBe(collectedB.length);
    // Crucial assertion: no new embedder calls.
    expect(embedCallCount).toBe(embedCallsAfterA);
    expect(totalEmbeddings).toBe(embedsAfterA);
  });
});
