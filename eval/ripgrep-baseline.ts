import { execSync } from "child_process";
import path from "path";

const STOP_WORDS = new Set([
  "the", "a", "an", "in", "of", "to", "for", "is", "it", "on",
  "at", "by", "with", "as", "from", "this", "that", "which",
  "and", "or", "not", "are", "be", "was", "were", "has", "have",
  "had", "do", "does", "did", "but", "if", "so", "no", "how",
  "get", "end",
]);

function extractKeywords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  // Sort by length descending, take up to 5
  words.sort((a, b) => b.length - a.length);
  return words.slice(0, 5);
}

function rgSearch(repoRoot: string, keyword: string): string[] {
  try {
    const output = execSync(
      `rg -l --glob '!node_modules' --glob '!*.db' --glob '!.git' ${JSON.stringify(keyword)} ${JSON.stringify(repoRoot)}`,
      { encoding: "utf-8", timeout: 10000 },
    );
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((f) => path.relative(repoRoot, f));
  } catch {
    // rg returns exit code 1 when no matches
    return [];
  }
}

export async function ripgrepBaseline(
  repoRoot: string,
  query: string,
  expectedFiles: string[],
): Promise<{ precision5: number; returnedFiles: string[] }> {
  const keywords = extractKeywords(query);

  if (keywords.length === 0) {
    return { precision5: 0, returnedFiles: [] };
  }

  // Count how many keywords each file matches
  const fileCounts = new Map<string, number>();
  for (const kw of keywords) {
    const files = rgSearch(repoRoot, kw);
    for (const f of files) {
      fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
    }
  }

  // Sort by match count descending
  const ranked = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);

  // Compute precision@5
  const top5 = ranked.slice(0, 5);
  if (expectedFiles.length === 0) {
    return { precision5: top5.length === 0 ? 1 : 0, returnedFiles: ranked };
  }
  const hits = top5.filter((f) => expectedFiles.includes(f)).length;
  const precision5 = hits / Math.min(5, expectedFiles.length);

  return { precision5, returnedFiles: ranked };
}
