import path from "path";

export interface ImportEdge {
  importedModule: string;
  language: string;
}

/**
 * Extract import edges from a file's content using regex patterns.
 * This is a lightweight approach that doesn't require tree-sitter —
 * it operates on source text and covers the most common import patterns.
 */
export function extractImports(filePath: string, content: string): ImportEdge[] {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
      return extractTsImports(content);
    case ".py":
      return extractPythonImports(content);
    case ".go":
      return extractGoImports(content);
    case ".rs":
      return extractRustImports(content);
    case ".java":
      return extractJavaImports(content);
    case ".kt":
    case ".kts":
      return extractKotlinImports(content);
    case ".rb":
      return extractRubyImports(content);
    case ".php":
      return extractPhpImports(content);
    case ".lua":
      return extractLuaImports(content);
    case ".zig":
      return extractZigImports(content);
    case ".ex":
    case ".exs":
      return extractElixirImports(content);
    default:
      return [];
  }
}

function deduplicateEdges(edges: ImportEdge[]): ImportEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    if (seen.has(e.importedModule)) return false;
    seen.add(e.importedModule);
    return true;
  });
}

/** Collect all regex matches as import edges for a given language. */
function matchAll(content: string, patterns: RegExp[], language: string): ImportEdge[] {
  return patterns.flatMap((re) =>
    [...content.matchAll(re)].map((m) => ({ importedModule: m[1], language })),
  );
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

function extractTsImports(content: string): ImportEdge[] {
  const edges = matchAll(
    content,
    [
      /import\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/g, // import ... from "module"
      /import\s+["']([^"']+)["']/g, // import "module" (side-effect)
      /require\s*\(\s*["']([^"']+)["']\s*\)/g, // require("module")
      /import\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("module")
    ],
    "typescript",
  );
  return deduplicateEdges(edges);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function extractPythonImports(content: string): ImportEdge[] {
  const edges = matchAll(
    content,
    [
      /^import\s+([\w.]+)/gm, // import module / import module.sub
      /^from\s+([\w.]+)\s+import/gm, // from module import ...
    ],
    "python",
  );
  return deduplicateEdges(edges);
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

function extractGoImports(content: string): ImportEdge[] {
  // Single import: import "path"
  const singleImports = matchAll(content, [/import\s+"([^"]+)"/g], "go");

  // Grouped imports: import ( ... )
  const groupRe = /import\s*\(([\s\S]*?)\)/g;
  const groupedImports = [...content.matchAll(groupRe)].flatMap((match) =>
    [...match[1].matchAll(/"([^"]+)"/g)].map((m) => ({ importedModule: m[1], language: "go" })),
  );

  return deduplicateEdges([...singleImports, ...groupedImports]);
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

function extractRustImports(content: string): ImportEdge[] {
  // use crate::module / use module::sub — extract parent module path
  const useEdges = [...content.matchAll(/use\s+([\w:]+(?:::[\w*{},\s]+)*)/g)]
    .map((match) => match[1].split("::").slice(0, -1).join("::"))
    .filter((modulePath) => modulePath.length > 0)
    .map((modulePath) => ({ importedModule: modulePath, language: "rust" }));

  // mod module
  const modEdges = matchAll(content, [/mod\s+(\w+)\s*;/g], "rust");

  return deduplicateEdges([...useEdges, ...modEdges]);
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

function extractJavaImports(content: string): ImportEdge[] {
  return deduplicateEdges(
    matchAll(content, [/import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/g], "java"),
  );
}

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

function extractKotlinImports(content: string): ImportEdge[] {
  return deduplicateEdges(matchAll(content, [/import\s+([\w.]+(?:\.\*)?)/g], "kotlin"));
}

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

function extractRubyImports(content: string): ImportEdge[] {
  return deduplicateEdges(
    matchAll(
      content,
      [
        /require\s+["']([^"']+)["']/g, // require "module"
        /require_relative\s+["']([^"']+)["']/g, // require_relative "module"
      ],
      "ruby",
    ),
  );
}

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

function extractPhpImports(content: string): ImportEdge[] {
  return deduplicateEdges(
    matchAll(
      content,
      [
        /use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;/g, // use Namespace\Class
        /(?:require|include)(?:_once)?\s+["']([^"']+)["']/g, // require/include
      ],
      "php",
    ),
  );
}

// ---------------------------------------------------------------------------
// Lua
// ---------------------------------------------------------------------------

function extractLuaImports(content: string): ImportEdge[] {
  return deduplicateEdges(
    matchAll(
      content,
      [
        /require\s*\(\s*["']([^"']+)["']\s*\)/g, // require("module")
        /require\s+(?!\()["']([^"']+)["']/g, // require 'module' (no parens)
      ],
      "lua",
    ),
  );
}

// ---------------------------------------------------------------------------
// Zig
// ---------------------------------------------------------------------------

function extractZigImports(content: string): ImportEdge[] {
  return deduplicateEdges(matchAll(content, [/@import\s*\(\s*"([^"]+)"\s*\)/g], "zig"));
}

// ---------------------------------------------------------------------------
// Elixir
// ---------------------------------------------------------------------------

function extractElixirImports(content: string): ImportEdge[] {
  // alias Module.Name (non-destructured)
  const aliasEdges = [...content.matchAll(/alias\s+([\w.]+)(?!\.\{)/g)]
    .map((match) => match[1].replace(/\.$/, ""))
    .filter((mod) => mod.length > 0)
    .map((mod) => ({ importedModule: mod, language: "elixir" }));

  // alias Module.{A, B} — expand destructured aliases
  const destructuredEdges = [...content.matchAll(/alias\s+([\w.]+)\.\{([^}]+)\}/g)].flatMap(
    (match) =>
      match[2]
        .split(",")
        .map((s) => s.trim())
        .filter((member) => member.length > 0)
        .map((member) => ({ importedModule: `${match[1]}.${member}`, language: "elixir" })),
  );

  // import, use, require
  const otherEdges = matchAll(
    content,
    [
      /import\s+([\w.]+)/g, // import Module
      /use\s+([\w.]+)/g, // use Module
      /require\s+([\w.]+)/g, // require Module
    ],
    "elixir",
  );

  return deduplicateEdges([...aliasEdges, ...destructuredEdges, ...otherEdges]);
}

// ---------------------------------------------------------------------------
// Resolution: map import module to a file path in the index
// ---------------------------------------------------------------------------

/**
 * Resolve a TS/JS import module to a file path in the indexed file list.
 * Handles relative paths (./foo, ../bar) with extension probing.
 */
export function resolveImport(
  importedModule: string,
  sourceFile: string,
  language: string,
  allFiles: Set<string>,
): string | null {
  if (language === "typescript" || language === "javascript") {
    return resolveTsImport(importedModule, sourceFile, allFiles);
  }
  if (language === "python") {
    return resolvePythonImport(importedModule, allFiles);
  }
  if (language === "go") {
    return resolveGoImport(importedModule, sourceFile, allFiles);
  }
  if (language === "ruby") {
    return resolveRubyImport(importedModule, sourceFile, allFiles);
  }
  if (language === "kotlin" || language === "java") {
    return resolveJvmImport(importedModule, allFiles);
  }
  return null;
}

function resolveTsImport(module: string, sourceFile: string, allFiles: Set<string>): string | null {
  // Skip node_modules / bare specifiers
  if (!module.startsWith(".") && !module.startsWith("/")) return null;

  const dir = path.dirname(sourceFile);
  const resolved = path.normalize(path.join(dir, module));

  // Try extensions
  const extensions = [".ts", ".tsx", ".js", ".jsx"];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (allFiles.has(candidate)) return candidate;
  }

  // Try index files
  for (const ext of extensions) {
    const candidate = path.join(resolved, `index${ext}`);
    if (allFiles.has(candidate)) return candidate;
  }

  // Try exact match (already has extension)
  if (allFiles.has(resolved)) return resolved;

  return null;
}

function resolvePythonImport(module: string, allFiles: Set<string>): string | null {
  // Convert dotted module path to file path
  const filePath = module.replace(/\./g, "/");

  // Try as a file
  const withPy = filePath + ".py";
  if (allFiles.has(withPy)) return withPy;

  // Try as a package __init__.py
  const initPy = path.join(filePath, "__init__.py");
  if (allFiles.has(initPy)) return initPy;

  return null;
}

// ---------------------------------------------------------------------------
// Go resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a Go import path to a file in the indexed file list.
 * Uses go.mod module path to map import paths to local directories.
 * For example, if go.mod declares "module github.com/user/project" and the
 * import is "github.com/user/project/pkg/foo", resolves to "pkg/foo/*.go".
 */
// Pre-built index mapping directory paths to a representative .go file
const goDirIndexCache = new WeakMap<Set<string>, Map<string, string>>();

function getGoDirIndex(allFiles: Set<string>): Map<string, string> {
  const cached = goDirIndexCache.get(allFiles);
  if (cached) return cached;
  const index = new Map<string, string>();
  for (const file of allFiles) {
    if (!file.endsWith(".go")) continue;
    const dir = path.dirname(file);
    if (!index.has(dir)) {
      index.set(dir, file);
    }
  }
  goDirIndexCache.set(allFiles, index);
  return index;
}

function resolveGoImport(
  importPath: string,
  sourceFile: string,
  allFiles: Set<string>,
): string | null {
  // Standard library imports (no dots in first segment) — skip
  const firstSegment = importPath.split("/")[0];
  if (!firstSegment.includes(".")) return null;

  const dirIndex = getGoDirIndex(allFiles);
  const segments = importPath.split("/");

  // Try progressively shorter suffixes of the import path as directory paths
  for (let i = 0; i < segments.length; i++) {
    const dirSuffix = segments.slice(i).join("/");

    for (const [dir, file] of dirIndex) {
      if (dir === dirSuffix || dir.endsWith("/" + dirSuffix)) {
        return file;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Ruby resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a Ruby require/require_relative to a file path.
 * - require_relative: resolved relative to the source file
 * - require: checks lib/ directory convention
 */
function resolveRubyImport(
  module: string,
  sourceFile: string,
  allFiles: Set<string>,
): string | null {
  // require_relative: resolve relative to source file
  if (!module.startsWith("/")) {
    const dir = path.dirname(sourceFile);
    const relative = path.normalize(path.join(dir, module));

    // Try with .rb extension
    const withRb = relative + ".rb";
    if (allFiles.has(withRb)) return withRb;

    // Try exact match
    if (allFiles.has(relative)) return relative;
  }

  // require: check lib/ directory convention
  const libPath = path.join("lib", module);
  const withRb = libPath + ".rb";
  if (allFiles.has(withRb)) return withRb;
  if (allFiles.has(libPath)) return libPath;

  // Try as direct path with .rb
  const directWithRb = module + ".rb";
  if (allFiles.has(directWithRb)) return directWithRb;
  if (allFiles.has(module)) return module;

  return null;
}

// ---------------------------------------------------------------------------
// Kotlin / Java resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a Kotlin/Java dotted package import to a file path.
 * Maps dotted package (e.g., com.example.MyClass) to directory path
 * and checks src/main/java/ and src/main/kotlin/ convention directories.
 */
// Pre-built index mapping directory paths to representative JVM files
const jvmDirIndexCache = new WeakMap<Set<string>, Map<string, string>>();

function getJvmDirIndex(allFiles: Set<string>): Map<string, string> {
  const cached = jvmDirIndexCache.get(allFiles);
  if (cached) return cached;
  const index = new Map<string, string>();
  for (const file of allFiles) {
    if (file.endsWith(".kt") || file.endsWith(".java") || file.endsWith(".kts")) {
      const dir = path.dirname(file);
      if (!index.has(dir)) {
        index.set(dir, file);
      }
    }
  }
  jvmDirIndexCache.set(allFiles, index);
  return index;
}

function resolveJvmImport(importPath: string, allFiles: Set<string>): string | null {
  // Convert dots to path separators
  const filePath = importPath.replace(/\./g, "/");

  // Strip wildcard imports (com.example.*)
  const cleanPath = filePath.replace(/\/\*$/, "");

  // Convention directories to check
  const prefixes = ["src/main/java/", "src/main/kotlin/", "src/", ""];

  // File extensions to try
  const extensions = [".kt", ".java", ".kts"];

  for (const prefix of prefixes) {
    for (const ext of extensions) {
      const candidate = prefix + cleanPath + ext;
      if (allFiles.has(candidate)) return candidate;
    }
  }

  // Fall back to directory-level lookup using pre-built index
  const dirIndex = getJvmDirIndex(allFiles);
  for (const prefix of prefixes) {
    const dirPath = (prefix + cleanPath).replace(/\/$/, "") || ".";
    const match = dirIndex.get(dirPath);
    if (match) return match;
  }

  return null;
}
