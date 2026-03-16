const ABBREVIATIONS: Record<string, string> = {
  auth: "authentication",
  db: "database",
  msg: "message",
  req: "request",
  res: "response",
  err: "error",
  fn: "function",
  cfg: "config configuration",
  ctx: "context",
  env: "environment",
  impl: "implementation",
  init: "initialization",
  iter: "iterator",
  lib: "library",
  mgr: "manager",
  num: "number",
  obj: "object",
  param: "parameter",
  pkg: "package",
  proc: "process",
  repo: "repository",
  srv: "server",
  str: "string",
  stmt: "statement",
  util: "utility",
  val: "value",
  var: "variable",
};

/**
 * Decompose camelCase/PascalCase identifiers into separate words.
 * e.g. "getUserName" → ["get", "User", "Name", "getUserName"]
 */
function decomposeCamelCase(term: string): string[] {
  const parts = term.replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/);
  return parts.length > 1 ? [...parts, term] : [term];
}

/**
 * Expand common abbreviations found in code identifiers.
 */
function expandAbbreviations(term: string): string[] {
  const lower = term.toLowerCase();
  const expansion = ABBREVIATIONS[lower];
  return expansion ? [term, ...expansion.split(" ")] : [term];
}

/**
 * Deduplicate terms while preserving order.
 */
function dedup(terms: string[]): string[] {
  const seen = new Set<string>();
  return terms.filter((t) => {
    const lower = t.toLowerCase();
    if (seen.has(lower) || t.length === 0) return false;
    seen.add(lower);
    return true;
  });
}

/**
 * Expand a query for better matching with local embedding models.
 * Applies camelCase decomposition, abbreviation expansion, and deduplication.
 */
export function expandQuery(query: string): string {
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);
  const expanded = tokens.flatMap((token) =>
    decomposeCamelCase(token).flatMap(expandAbbreviations),
  );
  return dedup(expanded).join(" ");
}
