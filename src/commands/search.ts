import { search, searchChanged } from "../search/query";
import type { SearchOptions } from "../search/types";

export async function cmdSearch(
  repoRoot: string,
  query: string,
  opts: {
    minScore?: number;
    topN?: number;
    scope?: string;
    includeSkeleton?: boolean;
    includeSummary?: boolean;
    includeSnippet?: boolean;
    format?: string;
    json?: boolean;
    pretty?: boolean;
    lang?: string[];
    dir?: string[];
    since?: string;
    explain?: boolean;
    changedSince?: string;
  },
) {
  // Build search options declaratively
  const resolveScope = (scope?: string): SearchOptions["scope"] => {
    if (scope === "all") return "all";
    if (scope && scope !== "project") return scope.split(",");
    return undefined;
  };

  const searchOpts: SearchOptions = {
    minScore: opts.minScore,
    topN: opts.topN,
    includeSkeleton: opts.includeSkeleton,
    includeSummary: opts.includeSummary,
    includeSnippet: opts.includeSnippet,
    lang: opts.lang,
    dir: opts.dir,
    since: opts.since,
    explain: opts.explain,
    scope: resolveScope(opts.scope),
  };

  // Select search strategy based on changedSince flag
  const runSearch = opts.changedSince
    ? () => searchChanged(repoRoot, opts.changedSince!, query, searchOpts)
    : () => search(repoRoot, query, searchOpts);

  const results = await runSearch();

  // Resolve output format: --format takes precedence over --pretty/--json
  const format = opts.format ?? (opts.pretty ? "pretty" : "json");

  if (format === "compact") {
    for (const r of results) {
      const line = r.lineStart != null ? `:${r.lineStart}` : "";
      console.log(`${r.filePath}${line}:${r.finalScore.toFixed(3)}`);
    }
  } else if (format === "pretty") {
    if (results.length === 0) {
      // zero-result diagnostic is printed below
    } else {
      const multiRepo = new Set(results.map((r) => r.repoName ?? r.repoId)).size > 1;
      for (const r of results) {
        const prefix = multiRepo && r.repoName ? `[${r.repoName}] ` : "";
        const lineInfo = r.lineStart != null ? ` L${r.lineStart}-L${r.lineEnd}` : "";
        console.log(
          `${prefix}${r.filePath}${lineInfo}  (${r.type})  score=${r.finalScore.toFixed(3)}  sim=${r.cosineSimilarity.toFixed(3)}`,
        );
        if (r.snippet) {
          const preview = r.snippet.split("\n").slice(0, 10).join("\n");
          console.log(`  ${preview.replace(/\n/g, "\n  ")}`);
        } else if (r.skeleton) {
          const preview = r.skeleton.split("\n").slice(0, 5).join("\n");
          console.log(`  ${preview.replace(/\n/g, "\n  ")}`);
        }
        if (r.summary) {
          console.log(`  ${r.summary}`);
        }
        if (r.explanation) {
          const e = r.explanation;
          console.log(`  [explain] ${e.formula}`);
          console.log(
            `    cosine=${e.cosineSimilarity.toFixed(3)} commit=${e.commitBoost.toFixed(3)} parent=${e.parentBoost.toFixed(3)}${e.childBoost != null ? ` child=${e.childBoost.toFixed(3)}` : ""}${e.keywordScore != null ? ` bm25=${e.keywordScore.toFixed(3)}` : ""}${e.lengthPenalty != null ? ` lenPen=${e.lengthPenalty.toFixed(3)}` : ""}`,
          );
        }
      }
    }
  } else {
    // json (default)
    console.log(JSON.stringify(results, null, 2));
  }

  // Zero-result diagnostics
  if (results.length === 0) {
    console.error(
      `No results found. Try: rg '${query}' or run 'codeindex doctor' to check index health.`,
    );
  }
}
