import type { Node } from "web-tree-sitter";
import { childText, childrenOfType, firstChildOfType, descendantsOfType } from "../skeleton-utils";

// ---------------------------------------------------------------------------
// Zig extractor
// ---------------------------------------------------------------------------

function extractZigImportFromDecl(node: Node): string | null {
  const builtins = descendantsOfType(node, ["builtin_function"]);
  for (const b of builtins) {
    const id = firstChildOfType(b, "builtin_identifier");
    if (id?.text === "@import") {
      const args = firstChildOfType(b, "arguments");
      if (args) {
        const str = firstChildOfType(args, "string");
        if (str) {
          const content = str.namedChildren.find((c) => c.type === "string_content");
          return content?.text ?? null;
        }
      }
    }
  }
  return null;
}

function extractZigParams(params: Node | null): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const p of params.namedChildren) {
    if (p.type === "parameter") {
      const name = childText(p, "name");
      const type_ = p.childForFieldName("type")?.text;
      const isComptime = p.children.some((c) => c.type === "comptime");
      const prefix = isComptime ? "comptime " : "";
      if (type_) parts.push(`${prefix}${name}: ${type_}`);
      else parts.push(`${prefix}${name}`);
    }
  }
  return parts.join(", ");
}

function extractZigReturnType(fn_: Node): string {
  const retNode = fn_.childForFieldName("type");
  if (!retNode) return "";
  return ` -> ${retNode.text}`;
}

export function skeletonZig(filename: string, root: Node): string {
  const lines: string[] = [`# ${filename} [Zig]`];

  // Imports: find @import() calls in top-level variable_declarations
  const imports: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type === "variable_declaration") {
      const importModule = extractZigImportFromDecl(node);
      if (importModule) imports.push(importModule);
    }
  }
  if (imports.length > 0) lines.push(`imports: ${imports.join(", ")}`);
  lines.push("");

  for (const node of root.namedChildren) {
    switch (node.type) {
      case "variable_declaration": {
        const name = firstChildOfType(node, "identifier")?.text;
        if (!name) break;
        const value = node.namedChildren.find(
          (c) =>
            c.type === "struct_declaration" ||
            c.type === "enum_declaration" ||
            c.type === "union_declaration" ||
            c.type === "error_set_declaration",
        );
        if (!value) break;
        const isPub = node.children.some((c) => c.type === "pub");
        const vis = isPub ? "pub " : "";

        switch (value.type) {
          case "struct_declaration": {
            lines.push(`${vis}struct ${name}`);
            const fields = childrenOfType(value, "container_field").filter(
              (f) => f.childForFieldName("type") != null,
            );
            for (const field of fields) {
              const fName = childText(field, "name");
              const fType = field.childForFieldName("type")?.text ?? "";
              lines.push(`  ${fName}: ${fType}`);
            }
            for (const fn_ of childrenOfType(value, "function_declaration")) {
              const fnName = childText(fn_, "name");
              const params = firstChildOfType(fn_, "parameters");
              const paramStr = extractZigParams(params);
              const retStr = extractZigReturnType(fn_);
              const fnPub = fn_.children.some((c) => c.type === "pub");
              lines.push(`  ${fnPub ? "+" : "-"} ${fnName}(${paramStr})${retStr}`);
            }
            lines.push("");
            break;
          }
          case "enum_declaration": {
            lines.push(`${vis}enum ${name}`);
            const variants = childrenOfType(value, "container_field").map((f) =>
              childText(f, "name"),
            );
            if (variants.length > 0) lines.push(`  variants: ${variants.join(", ")}`);
            for (const fn_ of childrenOfType(value, "function_declaration")) {
              const fnName = childText(fn_, "name");
              const params = firstChildOfType(fn_, "parameters");
              const paramStr = extractZigParams(params);
              const retStr = extractZigReturnType(fn_);
              const fnPub = fn_.children.some((c) => c.type === "pub");
              lines.push(`  ${fnPub ? "+" : "-"} ${fnName}(${paramStr})${retStr}`);
            }
            lines.push("");
            break;
          }
          case "union_declaration": {
            lines.push(`${vis}union ${name}`);
            const variants = childrenOfType(value, "container_field").map((f) => {
              const fName = childText(f, "name");
              const fType = f.childForFieldName("type")?.text;
              return fType ? `${fName}: ${fType}` : fName;
            });
            if (variants.length > 0) lines.push(`  variants: ${variants.join(", ")}`);
            for (const fn_ of childrenOfType(value, "function_declaration")) {
              const fnName = childText(fn_, "name");
              const params = firstChildOfType(fn_, "parameters");
              const paramStr = extractZigParams(params);
              const retStr = extractZigReturnType(fn_);
              const fnPub = fn_.children.some((c) => c.type === "pub");
              lines.push(`  ${fnPub ? "+" : "-"} ${fnName}(${paramStr})${retStr}`);
            }
            lines.push("");
            break;
          }
          case "error_set_declaration": {
            const errors = childrenOfType(value, "identifier").map((id) => id.text);
            lines.push(`${vis}error ${name}`);
            if (errors.length > 0) lines.push(`  values: ${errors.join(", ")}`);
            lines.push("");
            break;
          }
        }
        break;
      }
      case "function_declaration": {
        const fnName = childText(node, "name");
        const params = firstChildOfType(node, "parameters");
        const paramStr = extractZigParams(params);
        const retStr = extractZigReturnType(node);
        const isPub = node.children.some((c) => c.type === "pub");
        lines.push(`${isPub ? "pub " : ""}function ${fnName}(${paramStr})${retStr}`);
        lines.push("");
        break;
      }
      case "test_declaration": {
        const strNode = firstChildOfType(node, "string");
        const testName = strNode
          ? (strNode.namedChildren.find((c) => c.type === "string_content")?.text ?? "unnamed")
          : "unnamed";
        lines.push(`test "${testName}"`);
        lines.push("");
        break;
      }
    }
  }

  return lines.join("\n").trimEnd();
}
