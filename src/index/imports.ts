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

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

function extractTsImports(content: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  // import ... from "module"
  const importFromRe = /import\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const match of content.matchAll(importFromRe)) {
    edges.push({ importedModule: match[1], language: "typescript" });
  }
  // import "module" (side-effect)
  const sideEffectRe = /import\s+["']([^"']+)["']/g;
  for (const match of content.matchAll(sideEffectRe)) {
    if (!edges.some((e) => e.importedModule === match[1])) {
      edges.push({ importedModule: match[1], language: "typescript" });
    }
  }
  // require("module")
  const requireRe = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of content.matchAll(requireRe)) {
    edges.push({ importedModule: match[1], language: "typescript" });
  }
  // dynamic import("module")
  const dynamicRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of content.matchAll(dynamicRe)) {
    if (!edges.some((e) => e.importedModule === match[1])) {
      edges.push({ importedModule: match[1], language: "typescript" });
    }
  }
  return deduplicateEdges(edges);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function extractPythonImports(content: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  // import module / import module.sub
  const importRe = /^import\s+([\w.]+)/gm;
  for (const match of content.matchAll(importRe)) {
    edges.push({ importedModule: match[1], language: "python" });
  }
  // from module import ...
  const fromRe = /^from\s+([\w.]+)\s+import/gm;
  for (const match of content.matchAll(fromRe)) {
    edges.push({ importedModule: match[1], language: "python" });
  }
  return deduplicateEdges(edges);
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

function extractGoImports(content: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  // Single import: import "path"
  const singleRe = /import\s+"([^"]+)"/g;
  for (const match of content.matchAll(singleRe)) {
    edges.push({ importedModule: match[1], language: "go" });
  }
  // Grouped imports: import ( ... )
  const groupRe = /import\s*\(([\s\S]*?)\)/g;
  for (const match of content.matchAll(groupRe)) {
    const pathRe = /"([^"]+)"/g;
    for (const pathMatch of match[1].matchAll(pathRe)) {
      edges.push({ importedModule: pathMatch[1], language: "go" });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

function extractRustImports(content: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  // use crate::module / use module::sub
  const useRe = /use\s+([\w:]+(?:::[\w*{},\s]+)*)/g;
  for (const match of content.matchAll(useRe)) {
    const modulePath = match[1].split("::").slice(0, -1).join("::");
    if (modulePath) {
      edges.push({ importedModule: modulePath, language: "rust" });
    }
  }
  // mod module
  const modRe = /mod\s+(\w+)\s*;/g;
  for (const match of content.matchAll(modRe)) {
    edges.push({ importedModule: match[1], language: "rust" });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

function extractJavaImports(content: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const importRe = /import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/g;
  for (const match of content.matchAll(importRe)) {
    edges.push({ importedModule: match[1], language: "java" });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

function extractKotlinImports(content: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const importRe = /import\s+([\w.]+(?:\.\*)?)/g;
  for (const match of content.matchAll(importRe)) {
    edges.push({ importedModule: match[1], language: "kotlin" });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

function extractRubyImports(content: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  // require "module" / require 'module'
  const requireRe = /require\s+["']([^"']+)["']/g;
  for (const match of content.matchAll(requireRe)) {
    edges.push({ importedModule: match[1], language: "ruby" });
  }
  // require_relative "module"
  const relativeRe = /require_relative\s+["']([^"']+)["']/g;
  for (const match of content.matchAll(relativeRe)) {
    edges.push({ importedModule: match[1], language: "ruby" });
  }
  return deduplicateEdges(edges);
}

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

function extractPhpImports(content: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  // use Namespace\Class
  const useRe = /use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;/g;
  for (const match of content.matchAll(useRe)) {
    edges.push({ importedModule: match[1], language: "php" });
  }
  // require/include
  const reqRe = /(?:require|include)(?:_once)?\s+["']([^"']+)["']/g;
  for (const match of content.matchAll(reqRe)) {
    edges.push({ importedModule: match[1], language: "php" });
  }
  return deduplicateEdges(edges);
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
function resolveGoImport(
  importPath: string,
  sourceFile: string,
  allFiles: Set<string>,
): string | null {
  // Standard library imports (no dots in first segment) — skip
  const firstSegment = importPath.split("/")[0];
  if (!firstSegment.includes(".")) return null;

  // Try to find the go.mod module path by scanning indexed files
  // Look for the import path suffix in indexed .go files
  const segments = importPath.split("/");

  // Try progressively shorter suffixes of the import path as directory paths
  for (let i = 0; i < segments.length; i++) {
    const dirSuffix = segments.slice(i).join("/");

    // Look for .go files in this directory
    for (const file of allFiles) {
      if (!file.endsWith(".go")) continue;
      const dir = path.dirname(file);
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

    // Also try as a directory (package-level import)
    for (const ext of extensions) {
      // Look for any file in the package directory
      const dirPrefix = prefix + cleanPath + "/";
      for (const file of allFiles) {
        if (file.startsWith(dirPrefix) && file.endsWith(ext)) {
          return file;
        }
      }
    }
  }

  return null;
}
