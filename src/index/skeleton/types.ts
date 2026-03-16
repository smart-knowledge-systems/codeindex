import type { SkeletonEntry } from "../../search/types";

// ---------------------------------------------------------------------------
// Extension → language name mapping
// ---------------------------------------------------------------------------

export type SupportedLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "c"
  | "cpp"
  | "c_sharp"
  | "kotlin"
  | "swift"
  | "ruby"
  | "php"
  | "lua"
  | "scala"
  | "zig"
  | "elixir";

export const EXT_TO_LANG: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".h": "c",
  ".cs": "c_sharp",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".rb": "ruby",
  ".php": "php",
  ".lua": "lua",
  ".scala": "scala",
  ".sc": "scala",
  ".zig": "zig",
  ".ex": "elixir",
  ".exs": "elixir",
};

export const LANG_DISPLAY: Record<SupportedLanguage, string> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  c: "C",
  cpp: "C++",
  c_sharp: "C#",
  kotlin: "Kotlin",
  swift: "Swift",
  ruby: "Ruby",
  php: "PHP",
  lua: "Lua",
  scala: "Scala",
  zig: "Zig",
  elixir: "Elixir",
};

export interface SkeletonResult {
  text: string;
  entries: SkeletonEntry[];
}
