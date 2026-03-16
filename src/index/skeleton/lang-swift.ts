import type { Node } from "web-tree-sitter";
import { childText, firstChildOfType } from "../skeleton-utils";

// ---------------------------------------------------------------------------
// Swift extractor
// ---------------------------------------------------------------------------

/** Detect Swift declaration keyword from the first (anonymous) child of class_declaration. */
function swiftDeclKeyword(node: Node): string {
  const first = node.child(0);
  if (first) {
    const t = first.type;
    if (t === "struct") return "struct";
    if (t === "enum") return "enum";
    if (t === "extension") return "extension";
  }
  return "class";
}

function extractSwiftParams(params: Node | null): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const p of params.namedChildren) {
    if (p.type === "parameter") {
      const extName = p.childForFieldName("external_name");
      const intName = p.childForFieldName("name") ?? p.childForFieldName("internal_name");
      const type_ = p.childForFieldName("type");
      const label = extName?.text ?? intName?.text ?? "";
      parts.push(type_ ? `${label}: ${type_.text}` : label);
    }
  }
  return parts.join(", ");
}

export function skeletonSwift(filename: string, root: Node): string {
  const lines: string[] = [`# ${filename} [Swift]`];

  const imports: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type === "import_declaration") {
      const path_ = firstChildOfType(node, "identifier");
      if (path_) imports.push(path_.text);
    }
  }
  if (imports.length > 0) lines.push(`imports: ${imports.join(", ")}`);
  lines.push("");

  function processNode(node: Node, indent = ""): void {
    switch (node.type) {
      case "class_declaration": {
        const keyword = swiftDeclKeyword(node);
        const name =
          childText(node, "name") ?? firstChildOfType(node, "type_identifier", "user_type")?.text;
        lines.push(`${indent}${keyword} ${name ?? "(anonymous)"}`);
        const body = firstChildOfType(node, "class_body", "enum_class_body");
        if (body) {
          for (const member of body.namedChildren) processNode(member, indent + "  ");
        }
        lines.push("");
        break;
      }
      case "protocol_declaration": {
        const name = childText(node, "name");
        lines.push(`${indent}protocol ${name}`);
        const body = firstChildOfType(node, "protocol_body");
        if (body) {
          for (const member of body.namedChildren) processNode(member, indent + "  ");
        }
        lines.push("");
        break;
      }
      case "function_declaration": {
        const name =
          childText(node, "name") ?? firstChildOfType(node, "simple_identifier")?.text ?? "";
        const paramStr = extractSwiftParams(
          node.namedChildren.find((c) => c.type === "parameter_clause") ?? null,
        );
        const retType = firstChildOfType(node, "array_type", "user_type", "tuple_type");
        const retStr = retType ? ` -> ${retType.text}` : "";
        const mods = firstChildOfType(node, "modifiers");
        const vis = mods?.text.includes("private") ? "-" : "+";
        lines.push(`${indent}${vis} ${name}(${paramStr})${retStr}`);
        break;
      }
      case "property_declaration": {
        const pattern = firstChildOfType(node, "pattern");
        const name = pattern?.text ?? childText(node, "name") ?? "";
        if (name) {
          const type_ = firstChildOfType(node, "type_annotation");
          const typeStr = type_ ? type_.text : "";
          lines.push(`${indent}+ ${name}${typeStr}`);
        }
        break;
      }
      case "init_declaration": {
        const paramStr = extractSwiftParams(
          node.namedChildren.find((c) => c.type === "parameter_clause") ?? null,
        );
        lines.push(`${indent}+ init(${paramStr})`);
        break;
      }
      case "typealias_declaration": {
        const nameNode =
          node.childForFieldName("name") ?? firstChildOfType(node, "type_identifier");
        const name = nameNode?.text ?? "(anonymous)";
        const valueNode = node.namedChildren.find(
          (c) =>
            c !== nameNode &&
            (c.type === "type_identifier" ||
              c.type === "user_type" ||
              c.type === "array_type" ||
              c.type === "tuple_type"),
        );
        const valueStr = valueNode ? ` = ${valueNode.text}` : "";
        lines.push(`${indent}typealias ${name}${valueStr}`);
        break;
      }
      case "attribute": {
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
