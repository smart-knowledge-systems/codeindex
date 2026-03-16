import path from "path";
import { Parser } from "web-tree-sitter";
import type { SkeletonEntry } from "../../search/types";
import type { SkeletonResult } from "./types";
import { EXT_TO_LANG } from "./types";
import { initParser, loadLanguage } from "./init";
import { firstNLines } from "./helpers";
import { collectEntries } from "./entries";
import { skeletonTypeScript } from "./lang-ts";
import { skeletonPython } from "./lang-python";
import { skeletonRust } from "./lang-rust";
import { skeletonGo } from "./lang-go";
import { skeletonJava } from "./lang-java";
import { skeletonC } from "./lang-c";
import { skeletonCSharp } from "./lang-csharp";
import { skeletonKotlin } from "./lang-kotlin";
import { skeletonSwift } from "./lang-swift";
import { skeletonRuby } from "./lang-ruby";
import { skeletonPhp } from "./lang-php";
import { skeletonLua } from "./lang-lua";
import { skeletonScala } from "./lang-scala";
import { skeletonZig } from "./lang-zig";
import { skeletonElixir } from "./lang-elixir";

// ---------------------------------------------------------------------------
// Prose extractor for markdown/documentation files
// ---------------------------------------------------------------------------

/** Extensions treated as prose/documentation — get a structured extractor instead of firstNLines. */
const PROSE_EXTENSIONS = new Set([".md", ".mdx"]);

/** Maximum characters for prose skeleton — matches MAX_EMBED_CHARS in embedder.ts */
const MAX_PROSE_CHARS = 4_000;

/**
 * Extract a structured skeleton from a markdown/prose file.
 * Pulls headings, list items, and paragraph openings to create a meaningful
 * representation that embeds well for conceptual queries.
 */
function skeletonProse(content: string): { text: string; entries: SkeletonEntry[] } {
  const lines = content.split("\n");
  const parts: string[] = [];
  const entries: SkeletonEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Headings: # Title, ## Section, etc.
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      parts.push(line);
      entries.push({
        name: headingMatch[2].trim(),
        kind: `h${headingMatch[1].length}`,
        startLine: i + 1,
        endLine: i + 1,
      });
      continue;
    }

    // List items (- item, * item, 1. item)
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      parts.push(line);
      continue;
    }

    // Non-empty lines that start a paragraph (first non-blank after blank)
    if (trimmed.length > 0 && (i === 0 || lines[i - 1].trim() === "")) {
      parts.push(line);
      continue;
    }

    // Code fence labels
    if (trimmed.startsWith("```")) {
      parts.push(line);
      continue;
    }
  }

  // Use full content (up to MAX_PROSE_CHARS) to preserve searchable prose content.
  // The structured parts are still extracted for entries, but the text should retain
  // as much of the original document as possible for embedding quality.
  const fullText = content.length > MAX_PROSE_CHARS ? content.slice(0, MAX_PROSE_CHARS) : content;
  return { text: fullText, entries };
}

// ---------------------------------------------------------------------------
// Main exported functions
// ---------------------------------------------------------------------------

export async function extractSkeleton(
  filePath: string,
  content: string,
  fallbackLines = 50,
): Promise<string> {
  const result = await extractSkeletonWithEntries(filePath, content, fallbackLines);
  return result.text;
}

export async function extractSkeletonWithEntries(
  filePath: string,
  content: string,
  fallbackLines = 50,
): Promise<SkeletonResult> {
  const ext = path.extname(filePath).toLowerCase();
  const lang = EXT_TO_LANG[ext];
  const filename = path.basename(filePath);

  // Prose/documentation files get a structured extractor
  if (!lang && PROSE_EXTENSIONS.has(ext)) {
    const { text, entries } = skeletonProse(content);
    return { text, entries };
  }

  if (!lang) {
    return { text: firstNLines(content, fallbackLines), entries: [] };
  }

  try {
    await initParser();
  } catch {
    return { text: firstNLines(content, fallbackLines), entries: [] };
  }

  let language: Awaited<ReturnType<typeof loadLanguage>>;
  try {
    language = await loadLanguage(lang);
  } catch {
    return { text: firstNLines(content, fallbackLines), entries: [] };
  }

  let tree: ReturnType<Parser["parse"]>;
  try {
    const parser = new Parser();
    parser.setLanguage(language);
    tree = parser.parse(content);
  } catch {
    return { text: firstNLines(content, fallbackLines), entries: [] };
  }

  if (!tree) return { text: firstNLines(content, fallbackLines), entries: [] };

  try {
    const root = tree.rootNode;
    const entries = collectEntries(root);

    let text: string;
    switch (lang) {
      case "typescript":
      case "tsx":
      case "javascript":
        text = skeletonTypeScript(filename, root, lang);
        break;
      case "python":
        text = skeletonPython(filename, root);
        break;
      case "rust":
        text = skeletonRust(filename, root);
        break;
      case "go":
        text = skeletonGo(filename, root);
        break;
      case "java":
        text = skeletonJava(filename, root);
        break;
      case "c":
      case "cpp":
        text = skeletonC(filename, root, lang);
        break;
      case "c_sharp":
        text = skeletonCSharp(filename, root);
        break;
      case "kotlin":
        text = skeletonKotlin(filename, root);
        break;
      case "swift":
        text = skeletonSwift(filename, root);
        break;
      case "ruby":
        text = skeletonRuby(filename, root);
        break;
      case "php":
        text = skeletonPhp(filename, root);
        break;
      case "lua":
        text = skeletonLua(filename, root, content);
        break;
      case "scala":
        text = skeletonScala(filename, root);
        break;
      case "zig":
        text = skeletonZig(filename, root);
        break;
      case "elixir":
        text = skeletonElixir(filename, root);
        break;
      default:
        text = firstNLines(content, fallbackLines);
    }

    return { text, entries };
  } catch {
    return { text: firstNLines(content, fallbackLines), entries: [] };
  } finally {
    tree.delete();
  }
}
