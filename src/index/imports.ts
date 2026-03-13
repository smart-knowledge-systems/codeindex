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
    default:
      return [];
  }
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
  return edges;
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
  return edges;
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
  allFiles: string[],
): string | null {
  if (language === "typescript" || language === "javascript") {
    return resolveTsImport(importedModule, sourceFile, allFiles);
  }
  if (language === "python") {
    return resolvePythonImport(importedModule, allFiles);
  }
  // Go, Rust, Java: module resolution is package-based and harder to resolve
  // without knowing the module/package structure. Return null for now.
  return null;
}

function resolveTsImport(module: string, sourceFile: string, allFiles: string[]): string | null {
  // Skip node_modules / bare specifiers
  if (!module.startsWith(".") && !module.startsWith("/")) return null;

  const dir = path.dirname(sourceFile);
  const resolved = path.normalize(path.join(dir, module));

  // Try extensions
  const extensions = [".ts", ".tsx", ".js", ".jsx"];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (allFiles.includes(candidate)) return candidate;
  }

  // Try index files
  for (const ext of extensions) {
    const candidate = path.join(resolved, `index${ext}`);
    if (allFiles.includes(candidate)) return candidate;
  }

  // Try exact match (already has extension)
  if (allFiles.includes(resolved)) return resolved;

  return null;
}

function resolvePythonImport(module: string, allFiles: string[]): string | null {
  // Convert dotted module path to file path
  const filePath = module.replace(/\./g, "/");

  // Try as a file
  const withPy = filePath + ".py";
  if (allFiles.includes(withPy)) return withPy;

  // Try as a package __init__.py
  const initPy = path.join(filePath, "__init__.py");
  if (allFiles.includes(initPy)) return initPy;

  return null;
}
