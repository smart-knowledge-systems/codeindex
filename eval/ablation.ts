import fs from "fs";
import path from "path";
import type { ScoringConfig } from "../src/search/types";
import type { EvalQuery, EvalSummary } from "./types";
import { runEval } from "./run-eval";

// ---------------------------------------------------------------------------
// Config matrix
// ---------------------------------------------------------------------------

interface AblationConfig {
  name: string;
  overrides: Partial<ScoringConfig & { parentBoostMultiplier: number }>;
}

const CONFIG_MATRIX: AblationConfig[] = [
  { name: "baseline", overrides: {} },
  { name: "no-commit-boost", overrides: { alpha: 0 } },
  { name: "no-parent-boost", overrides: { beta: 0 } },
  { name: "no-child-boost", overrides: { gamma: 0 } },
  { name: "pure-cosine", overrides: { alpha: 0, beta: 0, gamma: 0 } },
  { name: "high-parent", overrides: { beta: 0.4, parentBoostMultiplier: 0.5 } },
  { name: "hybrid-0.3", overrides: { hybridWeight: 0.3 } },
  { name: "hybrid-0.5", overrides: { hybridWeight: 0.5 } },
  { name: "semantic-only", overrides: { hybridWeight: 0 } },
  { name: "length-penalty", overrides: { lengthPenaltyWeight: 0.05 } },
];

// ---------------------------------------------------------------------------
// Markdown comparison table
// ---------------------------------------------------------------------------

function generateComparisonMarkdown(summaries: EvalSummary[]): string {
  const lines: string[] = [];
  lines.push("# Ablation Study Results\n");
  lines.push(`Run at: ${summaries[0]?.timestamp ?? new Date().toISOString()}\n`);

  lines.push("## Aggregate Comparison\n");
  lines.push("| Config | Avg P@5 | Avg Recall | Avg MRR |");
  lines.push("|--------|---------|------------|---------|");
  for (const s of summaries) {
    lines.push(
      `| ${s.configName} | ${s.avgPrecision5.toFixed(3)} | ${s.avgRecall.toFixed(3)} | ${s.avgMrr.toFixed(3)} |`,
    );
  }

  lines.push("\n## Per-Query Breakdown\n");
  for (const s of summaries) {
    lines.push(`### ${s.configName}\n`);
    lines.push("| Query | P@5 | Recall | MRR |");
    lines.push("|-------|-----|--------|-----|");
    for (const r of s.results) {
      lines.push(
        `| ${r.queryId} | ${r.precision5.toFixed(2)} | ${r.recall.toFixed(2)} | ${r.mrr.toFixed(2)} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
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

  const summaries: EvalSummary[] = [];

  for (const config of CONFIG_MATRIX) {
    console.log(`\nRunning config: ${config.name}`);

    const { parentBoostMultiplier, ...scoringOverrides } = config.overrides;
    const results = await runEval(
      repoRoot,
      dataset,
      Object.keys(scoringOverrides).length > 0 ? scoringOverrides : undefined,
      parentBoostMultiplier,
    );

    const avgPrecision5 = results.reduce((s, r) => s + r.precision5, 0) / results.length;
    const avgRecall = results.reduce((s, r) => s + r.recall, 0) / results.length;
    const avgMrr = results.reduce((s, r) => s + r.mrr, 0) / results.length;

    const summary: EvalSummary = {
      configName: config.name,
      avgPrecision5,
      avgRecall,
      avgMrr,
      results,
      timestamp: new Date().toISOString(),
    };

    summaries.push(summary);

    fs.writeFileSync(
      path.join(outputDir, `${config.name}.json`),
      JSON.stringify(summary, null, 2),
    );

    console.log(`  P@5: ${avgPrecision5.toFixed(3)}  Recall: ${avgRecall.toFixed(3)}  MRR: ${avgMrr.toFixed(3)}`);
  }

  // Write combined ablation results
  fs.writeFileSync(
    path.join(outputDir, "ablation.json"),
    JSON.stringify(summaries, null, 2),
  );

  // Write comparison markdown
  const markdown = generateComparisonMarkdown(summaries);
  fs.writeFileSync(path.join(outputDir, "SUMMARY.md"), markdown);

  console.log(`\nAblation complete. Results in ${outputDir}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
