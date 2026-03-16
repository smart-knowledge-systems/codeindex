import type { Node } from "web-tree-sitter";
import { firstChildOfType, descendantsOfType } from "../skeleton-utils";

// ---------------------------------------------------------------------------
// Ruby extractor
// ---------------------------------------------------------------------------

export function skeletonRuby(filename: string, root: Node): string {
  const lines: string[] = [`# ${filename} [Ruby]`];

  const requires: string[] = [];
  for (const node of descendantsOfType(root, ["call"])) {
    const method = node.childForFieldName("method");
    if (method && (method.text === "require" || method.text === "require_relative")) {
      const args = node.childForFieldName("arguments");
      if (args) {
        const str = firstChildOfType(args, "string");
        if (str) requires.push(str.text.replace(/['"]/g, ""));
      }
    }
  }
  if (requires.length > 0) lines.push(`imports: ${requires.join(", ")}`);
  lines.push("");

  function processNode(node: Node, indent = ""): void {
    switch (node.type) {
      case "module": {
        const name = node.childForFieldName("name");
        lines.push(`${indent}module ${name?.text ?? "(anonymous)"}`);
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) processNode(child, indent + "  ");
        }
        lines.push("");
        break;
      }
      case "class": {
        const name = node.childForFieldName("name");
        const superclass = node.childForFieldName("superclass");
        const ext = superclass ? ` < ${superclass.text}` : "";
        lines.push(`${indent}class ${name?.text ?? "(anonymous)"}${ext}`);
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) processNode(child, indent + "  ");
        }
        lines.push("");
        break;
      }
      case "method": {
        const name = node.childForFieldName("name");
        const params = node.childForFieldName("parameters");
        const paramStr = params
          ? params.namedChildren
              .filter((p) => p.type !== "," && p.type !== "(")
              .map((p) => p.text)
              .join(", ")
          : "";
        lines.push(`${indent}+ ${name?.text ?? "(anonymous)"}(${paramStr})`);
        break;
      }
      case "singleton_method": {
        const name = node.childForFieldName("name");
        const params = node.childForFieldName("parameters");
        const paramStr = params
          ? params.namedChildren
              .filter((p) => p.type !== "," && p.type !== "(")
              .map((p) => p.text)
              .join(", ")
          : "";
        lines.push(`${indent}+ self.${name?.text ?? "(anonymous)"}(${paramStr})`);
        break;
      }
      case "call": {
        const method = node.childForFieldName("method");
        if (
          method &&
          (method.text === "attr_accessor" ||
            method.text === "attr_reader" ||
            method.text === "attr_writer")
        ) {
          const args = node.childForFieldName("arguments");
          if (args) {
            const symbols = args.namedChildren
              .filter((a) => a.type === "simple_symbol" || a.type === "symbol")
              .map((a) => a.text.replace(/^:/, ""));
            if (symbols.length > 0) {
              lines.push(`${indent}${method.text} ${symbols.join(", ")}`);
            }
          }
        }
        break;
      }
    }
  }

  for (const node of root.namedChildren) {
    processNode(node);
  }

  return lines.join("\n").trimEnd();
}
