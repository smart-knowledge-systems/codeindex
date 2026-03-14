import fs from "fs";
import path from "path";
import { search } from "../src/search/query";
import type { SearchOptions } from "../src/search/types";

// ---------------------------------------------------------------------------
// Benchmark queries — representative search workload
// ---------------------------------------------------------------------------

const BENCHMARK_QUERIES = [
  "database connection pool management",
  "authentication middleware",
  "error handling and retry logic",
  "file system walker with ignore patterns",
  "API endpoint routing",
  "configuration loading and validation",
  "logging infrastructure",
  "unit test fixtures and mocks",
  "CLI argument parsing",
  "deployment scripts",
  "type definitions and interfaces",
  "async function with error handling",
  "class inheritance hierarchy",
  "import resolution",
  "state management pattern",
  "caching strategy implementation",
  "webhook event processing",
  "data serialization format",
  "build system configuration",
  "environment variable loading",
  "search ranking algorithm",
  "embedding vector similarity",
  "tree-sitter AST parsing",
  "git commit history",
  "directory summarization",
  "secret detection patterns",
  "schema migration versioning",
  "cost tracking and budgets",
  "MCP server protocol",
  "cross-repository references",
  "batch processing pipeline",
  "queue worker implementation",
  "rate limiting middleware",
  "health check endpoint",
  "metrics collection and reporting",
  "template rendering engine",
  "dependency injection container",
  "event sourcing pattern",
  "pagination logic",
  "input validation and sanitization",
  "websocket connection handler",
  "file upload processing",
  "email notification service",
  "scheduled job runner",
  "feature flag evaluation",
  "permission and RBAC",
  "audit log recording",
  "data export and import",
  "compression and decompression",
  "distributed lock mechanism",
];

// ---------------------------------------------------------------------------
// Latency measurement
// ---------------------------------------------------------------------------

interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  samples: number;
}

function computeLatencyStats(latencies: number[]): LatencyStats {
  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    p50: sorted[Math.floor(n * 0.5)],
    p95: sorted[Math.floor(n * 0.95)],
    p99: sorted[Math.floor(n * 0.99)],
    mean: sorted.reduce((s, v) => s + v, 0) / n,
    min: sorted[0],
    max: sorted[n - 1],
    samples: n,
  };
}

// ---------------------------------------------------------------------------
// Memory measurement
// ---------------------------------------------------------------------------

interface MemoryStats {
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
}

function measureMemory(): MemoryStats {
  const mem = process.memoryUsage();
  return {
    heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
    heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
    rssMB: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
    externalMB: Math.round((mem.external / 1024 / 1024) * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Benchmark report
// ---------------------------------------------------------------------------

interface BenchmarkReport {
  timestamp: string;
  repoRoot: string;
  queryCount: number;
  searchLatency: LatencyStats;
  memoryBefore: MemoryStats;
  memoryAfter: MemoryStats;
  memoryPeak: MemoryStats;
  reindexTimeMs?: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let repoRoot = process.cwd();
  let outputPath: string | null = null;
  let queryCount = 50;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--repo":
        repoRoot = path.resolve(args[++i]);
        break;
      case "--output":
        outputPath = args[++i];
        break;
      case "--queries":
        queryCount = parseInt(args[++i]);
        break;
    }
  }

  console.log(`Scale Benchmark`);
  console.log(`  Repo: ${repoRoot}`);
  console.log(`  Queries: ${queryCount}`);
  console.log();

  const memBefore = measureMemory();
  let memPeak = { ...memBefore };

  function trackPeakMemory(): void {
    const current = measureMemory();
    if (current.rssMB > memPeak.rssMB) {
      memPeak = current;
    }
  }

  // Select queries — cycle through benchmark queries if needed
  const queries: string[] = [];
  for (let i = 0; i < queryCount; i++) {
    queries.push(BENCHMARK_QUERIES[i % BENCHMARK_QUERIES.length]);
  }

  // Run search queries and measure latency
  console.log(`Running ${queryCount} search queries...`);
  const latencies: number[] = [];
  let errors = 0;

  const searchOpts: SearchOptions = {
    topN: 10,
    minScore: 0.2,
  };

  for (let i = 0; i < queries.length; i++) {
    const start = performance.now();
    try {
      await search(repoRoot, queries[i], searchOpts);
    } catch {
      errors++;
    }
    const elapsed = performance.now() - start;
    latencies.push(elapsed);
    trackPeakMemory();

    if ((i + 1) % 10 === 0) {
      console.log(`  ${i + 1}/${queryCount} queries completed`);
    }
  }

  const memAfter = measureMemory();
  const latencyStats = computeLatencyStats(latencies);

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    repoRoot,
    queryCount,
    searchLatency: latencyStats,
    memoryBefore: memBefore,
    memoryAfter: memAfter,
    memoryPeak: memPeak,
    errors,
  };

  // Output report
  const reportJson = JSON.stringify(report, null, 2);

  if (outputPath) {
    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, reportJson);
    console.log(`\nReport written to ${outputPath}`);
  }

  // Print summary
  console.log(`\n--- Scale Benchmark Results ---`);
  console.log(`Repo: ${repoRoot}`);
  console.log(`Queries: ${queryCount} (${errors} errors)`);
  console.log();
  console.log(`Search Latency:`);
  console.log(`  p50:  ${latencyStats.p50.toFixed(1)} ms`);
  console.log(`  p95:  ${latencyStats.p95.toFixed(1)} ms`);
  console.log(`  p99:  ${latencyStats.p99.toFixed(1)} ms`);
  console.log(`  mean: ${latencyStats.mean.toFixed(1)} ms`);
  console.log(`  min:  ${latencyStats.min.toFixed(1)} ms`);
  console.log(`  max:  ${latencyStats.max.toFixed(1)} ms`);
  console.log();
  console.log(`Memory:`);
  console.log(`  Before: ${memBefore.rssMB} MB RSS, ${memBefore.heapUsedMB} MB heap`);
  console.log(`  After:  ${memAfter.rssMB} MB RSS, ${memAfter.heapUsedMB} MB heap`);
  console.log(`  Peak:   ${memPeak.rssMB} MB RSS, ${memPeak.heapUsedMB} MB heap`);

  if (!outputPath) {
    console.log(`\n${reportJson}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
