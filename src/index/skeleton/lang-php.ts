import type { Node } from "web-tree-sitter";
import { childrenOfType, firstChildOfType, descendantsOfType } from "../skeleton-utils";

// ---------------------------------------------------------------------------
// PHP extractor
// ---------------------------------------------------------------------------

function extractPhpParams(params: Node | null): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const p of params.namedChildren) {
    if (
      p.type === "simple_parameter" ||
      p.type === "property_promotion_parameter" ||
      p.type === "variadic_parameter"
    ) {
      const type_ = p.childForFieldName("type");
      const name = p.childForFieldName("name");
      parts.push(type_ ? `${name?.text ?? ""}: ${type_.text}` : (name?.text ?? p.text));
    }
  }
  return parts.join(", ");
}

export function skeletonPhp(filename: string, root: Node): string {
  const lines: string[] = [`# ${filename} [PHP]`];

  const imports: string[] = [];
  for (const node of descendantsOfType(root, ["namespace_use_declaration"])) {
    for (const clause of childrenOfType(node, "namespace_use_clause")) {
      const name = clause.childForFieldName("name") ?? firstChildOfType(clause, "qualified_name");
      if (name) imports.push(name.text);
    }
  }
  if (imports.length > 0) lines.push(`imports: ${imports.join(", ")}`);
  lines.push("");

  function processNode(node: Node, indent = ""): void {
    switch (node.type) {
      case "namespace_definition": {
        const name = node.childForFieldName("name");
        lines.push(`${indent}namespace ${name?.text ?? "(anonymous)"}`);
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) processNode(child, indent + "  ");
        }
        lines.push("");
        break;
      }
      case "class_declaration": {
        const name = node.childForFieldName("name");
        lines.push(`${indent}class ${name?.text ?? "(anonymous)"}`);
        const body = node.childForFieldName("body") ?? firstChildOfType(node, "declaration_list");
        if (body) {
          for (const member of body.namedChildren) processNode(member, indent + "  ");
        }
        lines.push("");
        break;
      }
      case "interface_declaration": {
        const name = node.childForFieldName("name");
        lines.push(`${indent}interface ${name?.text ?? "(anonymous)"}`);
        const body = node.childForFieldName("body") ?? firstChildOfType(node, "declaration_list");
        if (body) {
          for (const member of body.namedChildren) processNode(member, indent + "  ");
        }
        lines.push("");
        break;
      }
      case "trait_declaration": {
        const name = node.childForFieldName("name");
        lines.push(`${indent}trait ${name?.text ?? "(anonymous)"}`);
        const body = node.childForFieldName("body") ?? firstChildOfType(node, "declaration_list");
        if (body) {
          for (const member of body.namedChildren) processNode(member, indent + "  ");
        }
        lines.push("");
        break;
      }
      case "method_declaration": {
        const name = node.childForFieldName("name");
        const params = node.childForFieldName("parameters");
        const paramStr = extractPhpParams(params ?? null);
        const retType = node.childForFieldName("return_type");
        const retStr = retType ? ` -> ${retType.text}` : "";
        const vis = node.text.match(/^\s*(private|protected)/) ? "-" : "+";
        lines.push(`${indent}${vis} ${name?.text ?? "(anonymous)"}(${paramStr})${retStr}`);
        break;
      }
      case "enum_declaration": {
        const name = node.childForFieldName("name");
        lines.push(`${indent}enum ${name?.text ?? "(anonymous)"}`);
        const body =
          node.childForFieldName("body") ??
          firstChildOfType(node, "enum_declaration_list", "declaration_list");
        if (body) {
          for (const member of body.namedChildren) processNode(member, indent + "  ");
        }
        lines.push("");
        break;
      }
      case "enum_case": {
        const name = node.childForFieldName("name");
        if (name) lines.push(`${indent}case ${name.text}`);
        break;
      }
      case "function_definition": {
        const name = node.childForFieldName("name");
        const params = node.childForFieldName("parameters");
        const paramStr = extractPhpParams(params ?? null);
        const retType = node.childForFieldName("return_type");
        const retStr = retType ? ` -> ${retType.text}` : "";
        lines.push(`${indent}function ${name?.text ?? "(anonymous)"}(${paramStr})${retStr}`);
        lines.push("");
        break;
      }
      case "property_declaration": {
        const isReadonly = node.text.includes("readonly");
        const varNode = firstChildOfType(node, "property_element");
        const propName = varNode?.text ?? "";
        if (propName) {
          const modifier = isReadonly ? "readonly " : "";
          const vis = node.text.match(/^\s*(private|protected)/) ? "-" : "+";
          lines.push(`${indent}${vis} ${modifier}${propName}`);
        }
        break;
      }
      case "attribute_list": {
        lines.push(`${indent}${node.text}`);
        break;
      }
    }
  }

  for (const node of root.namedChildren) {
    processNode(node);
  }

  return lines.join("\n").trimEnd();
}
