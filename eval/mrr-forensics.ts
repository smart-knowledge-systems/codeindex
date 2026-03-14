import fs from "fs";
import path from "path";
import { runEval } from "./run-eval";
import type { EvalQuery, EvalResult } from "./types";
import type { ScoringConfig } from "../src/search/types";

// ---------------------------------------------------------------------------
// Scoring configurations for ablation study
// ---------------------------------------------------------------------------

interface ScoringProfile {
  name: string;
  description: string;
  overrides: Partial<ScoringConfig>;
}

const PROFILES: ScoringProfile[] = [
  {
    name: "baseline",
    description: "Default scoring (no overrides)",
    overrides: {},
  },
  {
    name: "no-hybrid",
    description: "Disable BM25 hybrid scoring",
    overrides: { hybridWeight: 0 },
  },
  {
    name: "no-length-penalty",
    description: "Disable length normalization penalty",
    overrides: { lengthPenaltyWeight: 0 },
  },
  {
    name: "no-parent-boost",
    description: "Disable parent directory boost",
    overrides: { beta: 0, parentBoostMultiplier: 0 },
  },
  {
    name: "no-commit-boost",
    description: "Disable commit recency boost",
    overrides: { alpha: 0 },
  },
  {
    name: "semantic-only",
    description: "Pure semantic similarity (no boosts, no penalties)",
    overrides: {
      hybridWeight: 0,
      lengthPenaltyWeight: 0,
      alpha: 0,
      beta: 0,
      parentBoostMultiplier: 0,
    },
  },
];

// ---------------------------------------------------------------------------
// Regression categorization
// ---------------------------------------------------------------------------

interface RegressionEntry {
  queryId: string;
  query: string;
  baselineMrr: number;
  expectedFiles: string[];
  cause: string;
  bestProfile: string;
  bestMrr: number;
  delta: number;
}

function categorizeRegression(
  queryId: string,
  baselineResult: EvalResult,
  profileResults: Map<string, EvalResult>,
): RegressionEntry | null {
  const baselineMrr = baselineResult.mrr;

  // Find the best-performing non-baseline profile for this query
  let bestProfile = "baseline";
  let bestMrr = baselineMrr;

  for (const [profileName, result] of profileResults) {
    if (profileName === "baseline") continue;
    if (result.mrr > bestMrr) {
      bestMrr = result.mrr;
      bestProfile = profileName;
    }
  }

  // Only report if a non-baseline config outperforms baseline significantly
  const delta = bestMrr - baselineMrr;
  if (delta < 0.05) return null;

  // Categorize the cause
  let cause: string;
  switch (bestProfile) {
    case "no-hybrid":
      cause = "hybrid-dilution";
      break;
    case "no-length-penalty":
      cause = "length-penalty";
      break;
    case "no-parent-boost":
      cause = "parent-boost-interference";
      break;
    case "no-commit-boost":
      cause = "commit-boost-noise";
      break;
    case "semantic-only":
      cause = "multi-factor-interference";
      break;
    default:
      cause = "unknown";
  }

  return {
    queryId,
    query: baselineResult.query,
    baselineMrr,
    expectedFiles: baselineResult.expectedFiles,
    cause,
    bestProfile,
    bestMrr,
    delta,
  };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

interface ForensicsReport {
  timestamp: string;
  profiles: Array<{
    name: string;
    description: string;
    avgMrr: number;
    avgPrecision5: number;
    avgRecall: number;
  }>;
  regressions: RegressionEntry[];
  causeSummary: Record<string, number>;
  recommendations: string[];
}

function generateReport(
  profileSummaries: Map<string, EvalResult[]>,
  regressions: RegressionEntry[],
): ForensicsReport {
  const profiles = [...profileSummaries.entries()].map(([name, results]) => {
    const profile = PROFILES.find((p) => p.name === name)!;
    return {
      name,
      description: profile.description,
      avgMrr: results.reduce((s, r) => s + r.mrr, 0) / results.length,
      avgPrecision5: results.reduce((s, r) => s + r.precision5, 0) / results.length,
      avgRecall: results.reduce((s, r) => s + r.recall, 0) / results.length,
    };
  });

  // Count regressions by cause
  const causeSummary: Record<string, number> = {};
  for (const r of regressions) {
    causeSummary[r.cause] = (causeSummary[r.cause] ?? 0) + 1;
  }

  // Generate recommendations based on findings
  const recommendations: string[] = [];
  const baselineProfile = profiles.find((p) => p.name === "baseline");
  const noHybridProfile = profiles.find((p) => p.name === "no-hybrid");
  const noLengthProfile = profiles.find((p) => p.name === "no-length-penalty");
  const noPBProfile = profiles.find((p) => p.name === "no-parent-boost");

  if (noHybridProfile && baselineProfile && noHybridProfile.avgMrr > baselineProfile.avgMrr) {
    recommendations.push(
      `Hybrid BM25 is hurting MRR (${baselineProfile.avgMrr.toFixed(3)} → ${noHybridProfile.avgMrr.toFixed(3)} without it). Consider reducing hybridWeight.`,
    );
  }

  if (noLengthProfile && baselineProfile && noLengthProfile.avgMrr > baselineProfile.avgMrr) {
    recommendations.push(
      `Length penalty is hurting MRR (${baselineProfile.avgMrr.toFixed(3)} → ${noLengthProfile.avgMrr.toFixed(3)} without it). Consider reducing lengthPenaltyWeight.`,
    );
  }

  if (noPBProfile && baselineProfile && noPBProfile.avgMrr > baselineProfile.avgMrr) {
    recommendations.push(
      `Parent boost is hurting MRR (${baselineProfile.avgMrr.toFixed(3)} → ${noPBProfile.avgMrr.toFixed(3)} without it). Consider reducing parentBoostMultiplier.`,
    );
  }

  if (
    (causeSummary["hybrid-dilution"] ?? 0) > regressions.length * 0.4 &&
    regressions.length > 0
  ) {
    recommendations.push(
      `${causeSummary["hybrid-dilution"]} of ${regressions.length} regressions caused by hybrid dilution — BM25 weight may be too high.`,
    );
  }

  if (recommendations.length === 0) {
    recommendations.push("No significant scoring regressions detected. Current config is stable.");
  }

  return {
    timestamp: new Date().toISOString(),
    profiles,
    regressions,
    causeSummary,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let repoRoot = process.cwd();
  let outputPath = path.join(import.meta.dir, "results", "mrr-forensics.json");
  let datasetFile = "dataset.json";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--repo":
        repoRoot = args[++i];
        break;
      case "--output":
        outputPath = args[++i];
        break;
      case "--dataset":
        datasetFile = args[++i];
        break;
    }
  }

  const datasetPath = path.resolve(
    datasetFile.startsWith("/") ? datasetFile : path.join(import.meta.dir, datasetFile),
  );
  const dataset: EvalQuery[] = JSON.parse(fs.readFileSync(datasetPath, "utf-8"));

  console.log(`MRR Forensics: ${dataset.length} queries, ${PROFILES.length} scoring profiles`);
  console.log(`Repo: ${repoRoot}\n`);

  const profileResults = new Map<string, EvalResult[]>();

  for (const profile of PROFILES) {
    console.log(`  Running profile: ${profile.name} — ${profile.description}`);
    const results = await runEval(repoRoot, dataset, profile.overrides);
    profileResults.set(profile.name, results);

    const avgMrr = results.reduce((s, r) => s + r.mrr, 0) / results.length;
    console.log(`    Avg MRR: ${avgMrr.toFixed(3)}`);
  }

  // Identify per-query regressions
  const baselineResults = profileResults.get("baseline")!;
  const regressions: RegressionEntry[] = [];

  for (const baseResult of baselineResults) {
    const queryProfileResults = new Map<string, EvalResult>();
    for (const [profileName, results] of profileResults) {
      const match = results.find((r) => r.queryId === baseResult.queryId);
      if (match) queryProfileResults.set(profileName, match);
    }

    const regression = categorizeRegression(baseResult.queryId, baseResult, queryProfileResults);
    if (regression) regressions.push(regression);
  }

  const report = generateReport(profileResults, regressions);

  // Write report
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  // Print summary
  console.log(`\n--- MRR Forensics Report ---`);
  console.log(`\nProfile comparison:`);
  for (const p of report.profiles) {
    console.log(`  ${p.name.padEnd(20)} MRR: ${p.avgMrr.toFixed(3)}  P@5: ${p.avgPrecision5.toFixed(3)}  Recall: ${p.avgRecall.toFixed(3)}`);
  }

  if (regressions.length > 0) {
    console.log(`\nRegressions found: ${regressions.length}`);
    console.log(`By cause:`);
    for (const [cause, count] of Object.entries(report.causeSummary)) {
      console.log(`  ${cause}: ${count}`);
    }
    console.log(`\nTop regressions:`);
    const sorted = [...regressions].sort((a, b) => b.delta - a.delta).slice(0, 10);
    for (const r of sorted) {
      console.log(
        `  ${r.queryId}: MRR ${r.baselineMrr.toFixed(3)} → ${r.bestMrr.toFixed(3)} (+${r.delta.toFixed(3)}) [${r.cause}]`,
      );
    }
  } else {
    console.log(`\nNo regressions found — baseline config is optimal.`);
  }

  console.log(`\nRecommendations:`);
  for (const rec of report.recommendations) {
    console.log(`  • ${rec}`);
  }

  console.log(`\nFull report: ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
