import fs from "fs";
import path from "path";
import { search } from "../src/search/query";
import type { SearchOptions, ScoringConfig } from "../src/search/types";
import type { EvalQuery, EvalResult, EvalSummary } from "./types";

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function computePrecisionAt5(returnedFiles: string[], expectedFiles: string[]): number {
  if (expectedFiles.length === 0) return returnedFiles.length === 0 ? 1 : 0;
  const top5 = returnedFiles.slice(0, 5);
  const hits = top5.filter((f) => expectedFiles.includes(f)).length;
  return hits / Math.min(5, expectedFiles.length);
}

function computeRecall(returnedFiles: string[], expectedFiles: string[]): number {
  if (expectedFiles.length === 0) return returnedFiles.length === 0 ? 1 : 0;
  const hits = expectedFiles.filter((f) => returnedFiles.includes(f)).length;
  return hits / expectedFiles.length;
}

function computeMrr(returnedFiles: string[], expectedFiles: string[]): number {
  if (expectedFiles.length === 0) return returnedFiles.length === 0 ? 1 : 0;
  for (let i = 0; i < returnedFiles.length; i++) {
    if (expectedFiles.includes(returnedFiles[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Core eval runner (exported for ablation)
// ---------------------------------------------------------------------------

export async function runEval(
  repoRoot: string,
  dataset: EvalQuery[],
  scoringOverrides?: Partial<ScoringConfig>,
  parentBoostMultiplier?: number,
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];

  for (const q of dataset) {
    const options: SearchOptions = {
      topN: 10,
      minScore: 0.1,
      scoringOverrides,
      parentBoostMultiplier,
    };

    const searchResults = await search(repoRoot, q.query, options);
    const returnedFiles = searchResults
      .filter((r) => r.type !== "commit")
      .map((r) => r.filePath);

    const precision5 = computePrecisionAt5(returnedFiles, q.expectedFiles);
    const recall = computeRecall(returnedFiles, q.expectedFiles);
    const mrr = computeMrr(returnedFiles, q.expectedFiles);

    results.push({
      queryId: q.id,
      query: q.query,
      precision5,
      recall,
      mrr,
      returnedFiles,
      expectedFiles: q.expectedFiles,
      scoringConfig: scoringOverrides ?? {},
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Markdown summary
// ---------------------------------------------------------------------------

function generateMarkdown(summary: EvalSummary, ripgrepSummary?: EvalSummary): string {
  const lines: string[] = [];
  lines.push(`# Eval Results: ${summary.configName}`);
  lines.push(`\nRun at: ${summary.timestamp}\n`);
  lines.push(`## Aggregate Metrics\n`);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Avg Precision@5 | ${summary.avgPrecision5.toFixed(3)} |`);
  lines.push(`| Avg Recall | ${summary.avgRecall.toFixed(3)} |`);
  lines.push(`| Avg MRR | ${summary.avgMrr.toFixed(3)} |`);

  if (ripgrepSummary) {
    lines.push(`\n## Ripgrep Baseline Comparison\n`);
    lines.push(`| Metric | codeindex | ripgrep |`);
    lines.push(`|--------|-----------|---------|`);
    lines.push(
      `| Avg Precision@5 | ${summary.avgPrecision5.toFixed(3)} | ${ripgrepSummary.avgPrecision5.toFixed(3)} |`,
    );
    lines.push(
      `| Avg Recall | ${summary.avgRecall.toFixed(3)} | ${ripgrepSummary.avgRecall.toFixed(3)} |`,
    );
    lines.push(
      `| Avg MRR | ${summary.avgMrr.toFixed(3)} | ${ripgrepSummary.avgMrr.toFixed(3)} |`,
    );
  }

  lines.push(`\n## Per-Query Results\n`);
  lines.push(`| Query | P@5 | Recall | MRR |`);
  lines.push(`|-------|-----|--------|-----|`);
  for (const r of summary.results) {
    lines.push(
      `| ${r.queryId} | ${r.precision5.toFixed(2)} | ${r.recall.toFixed(2)} | ${r.mrr.toFixed(2)} |`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let repoRoot = process.cwd();
  let outputDir = path.join(import.meta.dir, "results");
  let useRipgrep = false;
  let configName = "baseline";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--repo":
        repoRoot = args[++i];
        break;
      case "--output":
        outputDir = args[++i];
        break;
      case "--ripgrep":
        useRipgrep = true;
        break;
      case "--config-name":
        configName = args[++i];
        break;
    }
  }

  const datasetPath = path.join(import.meta.dir, "dataset.json");
  const dataset: EvalQuery[] = JSON.parse(fs.readFileSync(datasetPath, "utf-8"));

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Running eval: ${dataset.length} queries against ${repoRoot}`);
  const results = await runEval(repoRoot, dataset);

  const avgPrecision5 = results.reduce((s, r) => s + r.precision5, 0) / results.length;
  const avgRecall = results.reduce((s, r) => s + r.recall, 0) / results.length;
  const avgMrr = results.reduce((s, r) => s + r.mrr, 0) / results.length;

  const summary: EvalSummary = {
    configName,
    avgPrecision5,
    avgRecall,
    avgMrr,
    results,
    timestamp: new Date().toISOString(),
  };

  let ripgrepSummary: EvalSummary | undefined;

  if (useRipgrep) {
    const { ripgrepBaseline } = await import("./ripgrep-baseline");
    const rgResults: EvalResult[] = [];

    for (const q of dataset) {
      const rg = await ripgrepBaseline(repoRoot, q.query, q.expectedFiles);
      rgResults.push({
        queryId: q.id,
        query: q.query,
        precision5: rg.precision5,
        recall: computeRecall(rg.returnedFiles, q.expectedFiles),
        mrr: computeMrr(rg.returnedFiles, q.expectedFiles),
        returnedFiles: rg.returnedFiles,
        expectedFiles: q.expectedFiles,
        scoringConfig: {},
      });
    }

    const rgAvgP5 = rgResults.reduce((s, r) => s + r.precision5, 0) / rgResults.length;
    const rgAvgRecall = rgResults.reduce((s, r) => s + r.recall, 0) / rgResults.length;
    const rgAvgMrr = rgResults.reduce((s, r) => s + r.mrr, 0) / rgResults.length;

    ripgrepSummary = {
      configName: "ripgrep-baseline",
      avgPrecision5: rgAvgP5,
      avgRecall: rgAvgRecall,
      avgMrr: rgAvgMrr,
      results: rgResults,
      timestamp: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(outputDir, "ripgrep-baseline.json"),
      JSON.stringify(ripgrepSummary, null, 2),
    );
  }

  fs.writeFileSync(
    path.join(outputDir, `${configName}.json`),
    JSON.stringify(summary, null, 2),
  );

  const markdown = generateMarkdown(summary, ripgrepSummary);
  fs.writeFileSync(path.join(outputDir, "SUMMARY.md"), markdown);

  console.log(`\nResults written to ${outputDir}/`);
  console.log(`  Avg P@5:    ${avgPrecision5.toFixed(3)}`);
  console.log(`  Avg Recall: ${avgRecall.toFixed(3)}`);
  console.log(`  Avg MRR:    ${avgMrr.toFixed(3)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
