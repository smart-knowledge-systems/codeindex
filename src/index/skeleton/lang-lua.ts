import type { Node } from "web-tree-sitter";
import { firstChildOfType, extractParamList } from "../skeleton-utils";

// ---------------------------------------------------------------------------
// Lua extractor
// ---------------------------------------------------------------------------

export function skeletonLua(filename: string, root: Node, content: string): string {
  const lines: string[] = [`# ${filename} [Lua]`];

  // Imports: extract require() calls from raw source lines
  // (tree-sitter node.text can be truncated when multiple WASM languages are loaded)
  const imports: string[] = [];
  const sourceLines = content.split("\n");
  for (const node of root.namedChildren) {
    if (node.type !== "local_variable_declaration" && node.type !== "variable_assignment") continue;
    const line = sourceLines[node.startPosition.row] ?? "";
    const reqMatch = line.match(/require\s*\(?["']([^"']+)["']\)?/);
    if (reqMatch) imports.push(reqMatch[1]);
  }
  if (imports.length > 0) lines.push(`imports: ${imports.join(", ")}`);
  lines.push("");

  function processNode(node: Node, indent = ""): void {
    switch (node.type) {
      case "function_definition_statement": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        const params = firstChildOfType(node, "parameter_list");
        const paramStr = extractParamList(params, { paramTypes: ["identifier"] });
        lines.push(`${indent}+ ${name}(${paramStr})`);
        break;
      }
      case "local_function_definition_statement": {
        const nameNode = firstChildOfType(node, "identifier");
        const name = nameNode?.text ?? "(anonymous)";
        const params = firstChildOfType(node, "parameter_list");
        const paramStr = extractParamList(params, { paramTypes: ["identifier"] });
        lines.push(`${indent}+ ${name}(${paramStr}) [local]`);
        break;
      }
    }
  }

  for (const node of root.namedChildren) {
    processNode(node);
  }

  return lines.join("\n").trimEnd();
}
