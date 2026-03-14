import fs from "fs";
import path from "path";
import { search } from "../src/search/query";
import type { SearchOptions, ScoringConfig } from "../src/search/types";
import type { EvalQuery, EvalResult, EvalSummary } from "./types";
import { validateDataset, printValidationReport } from "./maintenance";

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function computePrecisionAt5(returnedFiles: string[], expectedFiles: string[]): number {
  if (expectedFiles.length === 0) return returnedFiles.length === 0 ? 1 : 0;
  const top5 = returnedFiles.slice(0, 5);
  const hits = top5.filter((f) => expectedFiles.includes(f)).length;
  return hits / 5;
}

/** HitRate@5: fraction of expected files found in top 5 results. */
function computeHitRateAt5(returnedFiles: string[], expectedFiles: string[]): number {
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

function computeNdcg(returnedFiles: string[], expectedFiles: string[], k = 10): number {
  if (expectedFiles.length === 0) return returnedFiles.length === 0 ? 1 : 0;

  // DCG: sum of relevance / log2(rank + 1) for returned results
  let dcg = 0;
  const topK = returnedFiles.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    const rel = expectedFiles.includes(topK[i]) ? 1 : 0;
    dcg += rel / Math.log2(i + 2); // log2(rank+1) where rank is 1-indexed
  }

  // Ideal DCG: all expected files ranked at the top
  let idcg = 0;
  const idealCount = Math.min(expectedFiles.length, k);
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
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
    const mergedOverrides: Partial<ScoringConfig> | undefined =
      scoringOverrides != null || parentBoostMultiplier != null
        ? {
            ...scoringOverrides,
            ...(parentBoostMultiplier != null ? { parentBoostMultiplier } : {}),
          }
        : undefined;

    const options: SearchOptions = {
      topN: 10,
      minScore: 0.1,
      scoringOverrides: mergedOverrides,
    };

    const searchResults = await search(repoRoot, q.query, options);
    const returnedFiles = searchResults
      .filter((r) => r.type !== "commit")
      .map((r) => r.filePath);

    const precision5 = computePrecisionAt5(returnedFiles, q.expectedFiles);
    const hitRate5 = computeHitRateAt5(returnedFiles, q.expectedFiles);
    const recall = computeRecall(returnedFiles, q.expectedFiles);
    const mrr = computeMrr(returnedFiles, q.expectedFiles);
    const ndcg = computeNdcg(returnedFiles, q.expectedFiles);

    // Diversity metrics
    const top5Files = returnedFiles.slice(0, 5);
    const uniqueFilesInTop5 = new Set(top5Files).size;
    const uniqueDirsInTop5 = new Set(top5Files.map((f) => path.dirname(f))).size;

    results.push({
      queryId: q.id,
      query: q.query,
      precision5,
      hitRate5,
      recall,
      mrr,
      ndcg,
      returnedFiles,
      expectedFiles: q.expectedFiles,
      scoringConfig: scoringOverrides ?? {},
      uniqueFilesInTop5,
      uniqueDirsInTop5,
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
  lines.push(`| Avg P@5 | ${summary.avgPrecision5.toFixed(3)} |`);
  lines.push(`| Avg HitRate@5 | ${summary.avgHitRate5.toFixed(3)} |`);
  lines.push(`| Avg Recall | ${summary.avgRecall.toFixed(3)} |`);
  lines.push(`| Avg MRR | ${summary.avgMrr.toFixed(3)} |`);
  lines.push(`| Avg nDCG@10 | ${summary.avgNdcg.toFixed(3)} |`);
  if (summary.avgUniqueFilesInTop5 != null)
    lines.push(`| Avg Unique Files in Top 5 | ${summary.avgUniqueFilesInTop5.toFixed(2)} |`);
  if (summary.avgUniqueDirsInTop5 != null)
    lines.push(`| Avg Unique Dirs in Top 5 | ${summary.avgUniqueDirsInTop5.toFixed(2)} |`);
  if (summary.model) lines.push(`| Model | ${summary.model} |`);
  if (summary.costPer1kFiles != null)
    lines.push(`| Cost / 1K files | $${summary.costPer1kFiles.toFixed(4)} |`);

  lines.push("");
  lines.push(
    `> **P@5** = hits in top 5 / 5 (standard). **HitRate@5** = hits in top 5 / min(5, expected) — more useful when most queries have 1 expected file.`,
  );

  if (ripgrepSummary) {
    lines.push(`\n## Ripgrep Baseline Comparison\n`);
    lines.push(`| Metric | codeindex | ripgrep |`);
    lines.push(`|--------|-----------|---------|`);
    lines.push(
      `| Avg P@5 | ${summary.avgPrecision5.toFixed(3)} | ${ripgrepSummary.avgPrecision5.toFixed(3)} |`,
    );
    lines.push(
      `| Avg HitRate@5 | ${summary.avgHitRate5.toFixed(3)} | ${ripgrepSummary.avgHitRate5.toFixed(3)} |`,
    );
    lines.push(
      `| Avg Recall | ${summary.avgRecall.toFixed(3)} | ${ripgrepSummary.avgRecall.toFixed(3)} |`,
    );
    lines.push(
      `| Avg MRR | ${summary.avgMrr.toFixed(3)} | ${ripgrepSummary.avgMrr.toFixed(3)} |`,
    );
    lines.push(
      `| Avg nDCG@10 | ${summary.avgNdcg.toFixed(3)} | ${ripgrepSummary.avgNdcg.toFixed(3)} |`,
    );
  }

  lines.push(`\n## Per-Query Results\n`);
  lines.push(`| Query | P@5 | HR@5 | Recall | MRR | nDCG | Files@5 | Dirs@5 |`);
  lines.push(`|-------|-----|------|--------|-----|------|---------|--------|`);
  for (const r of summary.results) {
    lines.push(
      `| ${r.queryId} | ${r.precision5.toFixed(2)} | ${r.hitRate5.toFixed(2)} | ${r.recall.toFixed(2)} | ${r.mrr.toFixed(2)} | ${r.ndcg.toFixed(2)} | ${r.uniqueFilesInTop5 ?? "-"} | ${r.uniqueDirsInTop5 ?? "-"} |`,
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
  let datasetFile = "dataset.json";
  let filterRepo: string | undefined;
  let filterLang: string | undefined;
  let validate = false;

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
      case "--dataset":
        datasetFile = args[++i];
        break;
      case "--filter-repo":
        filterRepo = args[++i];
        break;
      case "--filter-lang":
        filterLang = args[++i];
        break;
      case "--validate":
        validate = true;
        break;
    }
  }

  const datasetPath = path.resolve(
    datasetFile.startsWith("/") ? datasetFile : path.join(import.meta.dir, datasetFile),
  );
  let dataset: EvalQuery[] = JSON.parse(fs.readFileSync(datasetPath, "utf-8"));

  // Apply repo/language filters
  if (filterRepo) {
    dataset = dataset.filter((q) => !q.repo || q.repo === filterRepo);
  }
  if (filterLang) {
    dataset = dataset.filter((q) => !q.language || q.language === filterLang);
  }

  // Validate dataset if requested
  if (validate) {
    const validationResult = validateDataset(repoRoot, dataset);
    printValidationReport(validationResult);
    if (validationResult.stale.length > 0) {
      console.log(`\nSkipping ${validationResult.stale.length} stale queries.`);
      dataset = validationResult.valid;
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Running eval: ${dataset.length} queries against ${repoRoot}`);
  const results = await runEval(repoRoot, dataset);

  const avgPrecision5 = results.reduce((s, r) => s + r.precision5, 0) / results.length;
  const avgHitRate5 = results.reduce((s, r) => s + r.hitRate5, 0) / results.length;
  const avgRecall = results.reduce((s, r) => s + r.recall, 0) / results.length;
  const avgMrr = results.reduce((s, r) => s + r.mrr, 0) / results.length;
  const avgNdcg = results.reduce((s, r) => s + r.ndcg, 0) / results.length;
  const avgUniqueFilesInTop5 =
    results.reduce((s, r) => s + (r.uniqueFilesInTop5 ?? 0), 0) / results.length;
  const avgUniqueDirsInTop5 =
    results.reduce((s, r) => s + (r.uniqueDirsInTop5 ?? 0), 0) / results.length;

  const summary: EvalSummary = {
    configName,
    avgPrecision5,
    avgHitRate5,
    avgRecall,
    avgMrr,
    avgNdcg,
    avgUniqueFilesInTop5,
    avgUniqueDirsInTop5,
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
        precision5: computePrecisionAt5(rg.returnedFiles, q.expectedFiles),
        hitRate5: computeHitRateAt5(rg.returnedFiles, q.expectedFiles),
        recall: computeRecall(rg.returnedFiles, q.expectedFiles),
        mrr: computeMrr(rg.returnedFiles, q.expectedFiles),
        ndcg: computeNdcg(rg.returnedFiles, q.expectedFiles),
        returnedFiles: rg.returnedFiles,
        expectedFiles: q.expectedFiles,
        scoringConfig: {},
      });
    }

    const rgAvgP5 = rgResults.reduce((s, r) => s + r.precision5, 0) / rgResults.length;
    const rgAvgHR5 = rgResults.reduce((s, r) => s + r.hitRate5, 0) / rgResults.length;
    const rgAvgRecall = rgResults.reduce((s, r) => s + r.recall, 0) / rgResults.length;
    const rgAvgMrr = rgResults.reduce((s, r) => s + r.mrr, 0) / rgResults.length;
    const rgAvgNdcg = rgResults.reduce((s, r) => s + r.ndcg, 0) / rgResults.length;

    ripgrepSummary = {
      configName: "ripgrep-baseline",
      avgPrecision5: rgAvgP5,
      avgHitRate5: rgAvgHR5,
      avgRecall: rgAvgRecall,
      avgMrr: rgAvgMrr,
      avgNdcg: rgAvgNdcg,
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
  console.log(`  Avg HR@5:   ${avgHitRate5.toFixed(3)}`);
  console.log(`  Avg Recall: ${avgRecall.toFixed(3)}`);
  console.log(`  Avg MRR:    ${avgMrr.toFixed(3)}`);
  console.log(`  Avg nDCG:   ${avgNdcg.toFixed(3)}`);
  console.log(`  Avg Unique Files@5: ${avgUniqueFilesInTop5.toFixed(2)}`);
  console.log(`  Avg Unique Dirs@5:  ${avgUniqueDirsInTop5.toFixed(2)}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
