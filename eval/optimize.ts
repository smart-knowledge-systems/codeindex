import fs from "fs";
import path from "path";
import type { ScoringConfig } from "../src/search/types";
import type { EvalQuery, EvalSummary } from "./types";
import { runEval } from "./run-eval";

// ---------------------------------------------------------------------------
// Grid search space
// ---------------------------------------------------------------------------

const GRID = {
  alpha: [0.1, 0.15, 0.2, 0.25],
  beta: [0.15, 0.2, 0.25],
  hybridWeight: [0.2, 0.3, 0.4, 0.5],
  lengthPenaltyWeight: [0.0, 0.03, 0.05, 0.08],
  minScore: [0.2, 0.25, 0.3],
};

interface GridResult {
  config: Partial<ScoringConfig>;
  avgPrecision5: number;
  avgRecall: number;
  avgMrr: number;
  objective: number;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let repoRoot = process.cwd();
  let outputDir = path.join(import.meta.dir, "results");

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--repo":
        repoRoot = args[++i];
        break;
      case "--output":
        outputDir = args[++i];
        break;
    }
  }

  const datasetPath = path.join(import.meta.dir, "dataset.json");
  const dataset: EvalQuery[] = JSON.parse(fs.readFileSync(datasetPath, "utf-8"));

  fs.mkdirSync(outputDir, { recursive: true });

  const totalCombinations =
    GRID.alpha.length *
    GRID.beta.length *
    GRID.hybridWeight.length *
    GRID.lengthPenaltyWeight.length *
    GRID.minScore.length;

  console.log(`Grid search: ${totalCombinations} combinations against ${dataset.length} queries`);

  const gridResults: GridResult[] = [];
  let iteration = 0;

  for (const alpha of GRID.alpha) {
    for (const beta of GRID.beta) {
      for (const hybridWeight of GRID.hybridWeight) {
        for (const lengthPenaltyWeight of GRID.lengthPenaltyWeight) {
          for (const minScore of GRID.minScore) {
            iteration++;
            const config: Partial<ScoringConfig> = {
              alpha,
              beta,
              hybridWeight,
              lengthPenaltyWeight,
              minScore,
            };

            const results = await runEval(repoRoot, dataset, config);

            const avgPrecision5 =
              results.reduce((s, r) => s + r.precision5, 0) / results.length;
            const avgRecall = results.reduce((s, r) => s + r.recall, 0) / results.length;
            const avgMrr = results.reduce((s, r) => s + r.mrr, 0) / results.length;
            const objective = avgPrecision5 + avgMrr;

            gridResults.push({
              config,
              avgPrecision5,
              avgRecall,
              avgMrr,
              objective,
            });

            if (iteration % 10 === 0 || iteration === totalCombinations) {
              process.stderr.write(
                `\r${iteration}/${totalCombinations}  best=${Math.max(...gridResults.map((r) => r.objective)).toFixed(3)}`,
              );
            }
          }
        }
      }
    }
  }

  process.stderr.write("\n");

  // Sort by objective descending
  gridResults.sort((a, b) => b.objective - a.objective);

  const best = gridResults[0];
  console.log("\nBest config:");
  console.log(JSON.stringify(best.config, null, 2));
  console.log(
    `  P@5: ${best.avgPrecision5.toFixed(3)}  Recall: ${best.avgRecall.toFixed(3)}  MRR: ${best.avgMrr.toFixed(3)}  Objective: ${best.objective.toFixed(3)}`,
  );

  // Write results
  const output = {
    timestamp: new Date().toISOString(),
    totalCombinations,
    best: best,
    top10: gridResults.slice(0, 10),
    all: gridResults,
  };

  fs.writeFileSync(path.join(outputDir, "optimization.json"), JSON.stringify(output, null, 2));

  // Generate summary
  const summaryLines = [
    "# Scoring Weight Optimization Results\n",
    `Run at: ${output.timestamp}`,
    `Grid size: ${totalCombinations} combinations\n`,
    "## Best Config\n",
    "```json",
    JSON.stringify(best.config, null, 2),
    "```\n",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| P@5 | ${best.avgPrecision5.toFixed(3)} |`,
    `| Recall | ${best.avgRecall.toFixed(3)} |`,
    `| MRR | ${best.avgMrr.toFixed(3)} |`,
    `| Objective (P@5 + MRR) | ${best.objective.toFixed(3)} |`,
    "",
    "## Top 10 Configs\n",
    "| # | alpha | beta | hybridWeight | lengthPenalty | minScore | P@5 | MRR | Objective |",
    "|---|-------|------|-------------|---------------|----------|-----|-----|-----------|",
    ...gridResults.slice(0, 10).map(
      (r, i) =>
        `| ${i + 1} | ${r.config.alpha} | ${r.config.beta} | ${r.config.hybridWeight} | ${r.config.lengthPenaltyWeight} | ${r.config.minScore} | ${r.avgPrecision5.toFixed(3)} | ${r.avgMrr.toFixed(3)} | ${r.objective.toFixed(3)} |`,
    ),
  ];

  fs.writeFileSync(path.join(outputDir, "SUMMARY.md"), summaryLines.join("\n"));

  console.log(`\nResults written to ${outputDir}/optimization.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
