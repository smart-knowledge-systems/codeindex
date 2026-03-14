import fs from "fs";
import path from "path";
import type { EvalQuery } from "./types";

/**
 * Validate that expected files in the dataset still exist on disk.
 */
export function validateDataset(
  repoRoot: string,
  dataset: EvalQuery[],
): { valid: EvalQuery[]; stale: Array<{ query: EvalQuery; missingFiles: string[] }> } {
  const valid: EvalQuery[] = [];
  const stale: Array<{ query: EvalQuery; missingFiles: string[] }> = [];

  for (const q of dataset) {
    const missing = q.expectedFiles.filter((f) => {
      const absPath = path.join(repoRoot, f);
      return !fs.existsSync(absPath);
    });

    if (missing.length > 0) {
      stale.push({ query: q, missingFiles: missing });
    } else {
      valid.push(q);
    }
  }

  return { valid, stale };
}

/**
 * Print a validation report.
 */
export function printValidationReport(
  result: ReturnType<typeof validateDataset>,
): void {
  console.log(`\nDataset Validation Report`);
  console.log(`Valid queries: ${result.valid.length}`);
  console.log(`Stale queries: ${result.stale.length}`);

  if (result.stale.length > 0) {
    console.log(`\nStale queries:`);
    for (const s of result.stale) {
      console.log(`  ${s.query.id}: missing ${s.missingFiles.join(", ")}`);
    }
  }
}
