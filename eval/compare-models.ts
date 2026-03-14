/**
 * Embedding model comparison framework.
 *
 * Runs the eval dataset against the currently indexed data and outputs a
 * comparison table with nDCG, MRR, P@5, and cost per 1K files.
 *
 * Usage:
 *   bun run eval/compare-models.ts [--model <name>] [--repo <path>]
 *
 * Currently supports running against whichever model was used to index the repo.
 * To compare models, reindex with a different model and re-run.
 * The output is designed to be appended to a comparison table across runs.
 */

import fs from "fs";
import path from "path";
import { runEval } from "./run-eval";
import { PRICING } from "../src/cost";
import type { EvalQuery, EvalSummary } from "./types";

const AVG_TOKENS_PER_FILE = 500; // approximate average skeleton token count

function computeCostPer1kFiles(model: string): number {
  const pricing = PRICING[model];
  if (!pricing) return -1;
  // Cost = (avgTokens * 1000 files) / 1M tokens * price per 1M input tokens
  return (AVG_TOKENS_PER_FILE * 1000 * pricing.input) / 1_000_000;
}

async function main() {
  const args = process.argv.slice(2);
  let repoRoot = process.cwd();
  let model = "text-embedding-3-small";
  let outputDir = path.join(import.meta.dir, "results");

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model":
        model = args[++i];
        break;
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

  console.log(`Model comparison: ${model}`);
  console.log(`Dataset: ${dataset.length} queries against ${repoRoot}\n`);

  const results = await runEval(repoRoot, dataset);

  const avgP5 = results.reduce((s, r) => s + r.precision5, 0) / results.length;
  const avgHR5 = results.reduce((s, r) => s + r.hitRate5, 0) / results.length;
  const avgRecall = results.reduce((s, r) => s + r.recall, 0) / results.length;
  const avgMrr = results.reduce((s, r) => s + r.mrr, 0) / results.length;
  const avgNdcg = results.reduce((s, r) => s + r.ndcg, 0) / results.length;
  const costPer1k = computeCostPer1kFiles(model);

  const summary: EvalSummary = {
    configName: `model-${model}`,
    model,
    avgPrecision5: avgP5,
    avgHitRate5: avgHR5,
    avgRecall: avgRecall,
    avgMrr: avgMrr,
    avgNdcg: avgNdcg,
    costPer1kFiles: costPer1k,
    results,
    timestamp: new Date().toISOString(),
  };

  const outFile = path.join(outputDir, `model-${model.replace(/\//g, "-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));

  // Print comparison table row
  console.log("| Model | nDCG@10 | MRR | P@5 | HR@5 | Recall | Cost/1K files |");
  console.log("|-------|---------|-----|-----|------|--------|---------------|");
  console.log(
    `| ${model} | ${avgNdcg.toFixed(3)} | ${avgMrr.toFixed(3)} | ${avgP5.toFixed(3)} | ${avgHR5.toFixed(3)} | ${avgRecall.toFixed(3)} | $${costPer1k.toFixed(4)} |`,
  );

  // If previous model results exist, include them in the table
  const resultFiles = fs.readdirSync(outputDir).filter((f) => f.startsWith("model-") && f.endsWith(".json"));
  if (resultFiles.length > 1) {
    console.log("\n--- Full Comparison ---\n");
    console.log("| Model | nDCG@10 | MRR | P@5 | HR@5 | Recall | Cost/1K files |");
    console.log("|-------|---------|-----|-----|------|--------|---------------|");
    for (const f of resultFiles) {
      const data: EvalSummary = JSON.parse(fs.readFileSync(path.join(outputDir, f), "utf-8"));
      console.log(
        `| ${data.model ?? data.configName} | ${data.avgNdcg.toFixed(3)} | ${data.avgMrr.toFixed(3)} | ${data.avgPrecision5.toFixed(3)} | ${(data.avgHitRate5 ?? 0).toFixed(3)} | ${data.avgRecall.toFixed(3)} | $${(data.costPer1kFiles ?? -1).toFixed(4)} |`,
      );
    }
  }

  console.log(`\nResults written to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
