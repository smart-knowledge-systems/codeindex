// ---------------------------------------------------------------------------
// Pure scoring — no I/O, no mutation
// ---------------------------------------------------------------------------

import type { ScoringConfig, ScoreExplanation } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeCommitBoost(
  links: ReadonlyArray<{ recency: number; similarity: number }>,
  scoring: ScoringConfig,
): number {
  const { commitDecay, commitDepth } = scoring;
  let boost = 0;
  for (const link of links) {
    if (link.recency > commitDepth) continue;
    boost += link.similarity * Math.pow(1 - commitDecay, link.recency - 1);
  }
  return boost;
}

/** Prose file types exempt from length normalization penalty. */
const PROSE_FILE_TYPES = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);

/** Map file extension to language profile key. */
export const EXT_TO_LANG_KEY: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".cpp": "cpp",
  ".cs": "csharp",
};

/** Resolve per-language scoring overrides for a given file type. */
export function langScoring(
  fileType: string,
  base: ScoringConfig,
  profiles?: Record<string, Partial<ScoringConfig>>,
): ScoringConfig {
  if (!profiles) return base;
  const lang = EXT_TO_LANG_KEY[fileType];
  if (!lang) return base;
  const override = profiles[lang];
  if (!override) return base;
  return { ...base, ...override };
}

// ---------------------------------------------------------------------------
// File score
// ---------------------------------------------------------------------------

export interface FileScoreInput {
  readonly fileSim: number;
  readonly fileType: string;
  readonly skeletonLength: number;
  readonly avgTokenCount: number;
  readonly commitLinks: ReadonlyArray<{ recency: number; similarity: number }>;
  readonly dirSim: number;
  readonly rawBM25: number;
  readonly maxBM25: number;
  readonly minScore: number;
  readonly scoring: ScoringConfig;
  readonly languageProfiles?: Record<string, Partial<ScoringConfig>>;
}

export interface FileScoreOutput {
  readonly finalScore: number;
  readonly commitBoost: number;
  readonly parentBoost: number;
  readonly lengthPenalty: number;
  readonly normalizedBM25: number;
  readonly resolvedScoring: ScoringConfig;
}

/** Pure: compute all score components for a single file result. */
export function computeFileScore(input: FileScoreInput): FileScoreOutput {
  const fileScoring = langScoring(input.fileType, input.scoring, input.languageProfiles);
  const commitBoost = computeCommitBoost(input.commitLinks, fileScoring);
  const parentBoost =
    input.dirSim > input.minScore ? fileScoring.parentBoostMultiplier * input.dirSim : 0;

  const tokenCount = input.skeletonLength / 4;
  const isProse = PROSE_FILE_TYPES.has(input.fileType);
  const lengthPenalty =
    !isProse && tokenCount > 0
      ? Math.max(0, Math.log(tokenCount / input.avgTokenCount)) * input.scoring.lengthPenaltyWeight
      : 0;

  const semanticScore =
    input.fileSim +
    fileScoring.alpha * commitBoost +
    fileScoring.beta * parentBoost -
    lengthPenalty;

  const normalizedBM25 = input.maxBM25 > 0 ? input.rawBM25 / input.maxBM25 : 0;

  const { hybridWeight } = input.scoring;
  const finalScore =
    hybridWeight > 0
      ? (1 - hybridWeight) * semanticScore + hybridWeight * normalizedBM25
      : semanticScore;

  return {
    finalScore,
    commitBoost,
    parentBoost,
    lengthPenalty,
    normalizedBM25,
    resolvedScoring: fileScoring,
  };
}

// ---------------------------------------------------------------------------
// Directory score
// ---------------------------------------------------------------------------

/** Pure: compute directory score with child-to-parent boost. */
export function computeDirScore(
  concatSim: number,
  summarySim: number,
  childScores: readonly number[],
  gamma: number,
): number {
  const baseSim = Math.max(concatSim, summarySim);
  if (childScores.length >= 2) {
    const avg = childScores.reduce((a, b) => a + b, 0) / childScores.length;
    return baseSim + gamma * avg;
  }
  return baseSim;
}

// ---------------------------------------------------------------------------
// Explanation builders
// ---------------------------------------------------------------------------

/** Pure: build a file explanation object. */
export function buildFileExplanation(
  fileSim: number,
  score: FileScoreOutput,
  scoring: ScoringConfig,
): ScoreExplanation {
  const { alpha, beta, gamma } = scoring;
  const { hybridWeight } = scoring;
  return {
    cosineSimilarity: fileSim,
    commitBoost: score.commitBoost,
    parentBoost: score.parentBoost,
    keywordScore: score.normalizedBM25,
    lengthPenalty: score.lengthPenalty,
    weights: { alpha, beta, gamma },
    formula: `(1-${hybridWeight})*[${fileSim.toFixed(3)} + ${alpha}*${score.commitBoost.toFixed(3)} + ${beta}*${score.parentBoost.toFixed(3)} - ${score.lengthPenalty.toFixed(3)}] + ${hybridWeight}*${score.normalizedBM25.toFixed(3)} = ${score.finalScore.toFixed(3)}`,
  };
}

/** Pure: build a directory explanation object. */
export function buildDirExplanation(
  baseSim: number,
  finalScore: number,
  scoring: ScoringConfig,
): ScoreExplanation {
  const { alpha, beta, gamma } = scoring;
  return {
    cosineSimilarity: baseSim,
    commitBoost: 0,
    parentBoost: 0,
    childBoost: finalScore - baseSim,
    weights: { alpha, beta, gamma },
    formula: `${baseSim.toFixed(3)} + γ*childAvg = ${finalScore.toFixed(3)}`,
  };
}
