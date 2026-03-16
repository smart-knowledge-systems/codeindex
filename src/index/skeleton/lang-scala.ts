import type { Node } from "web-tree-sitter";
import { childText, firstChildOfType } from "../skeleton-utils";

// ---------------------------------------------------------------------------
// Scala extractor
// ---------------------------------------------------------------------------

function extractScalaParams(params: Node | null): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const p of params.namedChildren) {
    if (p.type === "parameter") {
      const name = childText(p, "name") || firstChildOfType(p, "identifier")?.text || "";
      const type_ =
        p.childForFieldName("type") ?? firstChildOfType(p, "type_identifier", "generic_type");
      parts.push(type_ ? `${name}: ${type_.text}` : name);
    } else if (p.type === "class_parameter") {
      const name = childText(p, "name") || firstChildOfType(p, "identifier")?.text || "";
      const type_ =
        p.childForFieldName("type") ?? firstChildOfType(p, "type_identifier", "generic_type");
      parts.push(type_ ? `${name}: ${type_.text}` : name);
    }
  }
  return parts.join(", ");
}

export function extractScalaReturnType(node: Node): string {
  const ret = node.childForFieldName("return_type");
  if (ret) return ` -> ${ret.text}`;
  const typeNode = firstChildOfType(node, "type_identifier", "generic_type");
  const params = firstChildOfType(node, "parameters", "class_parameters");
  if (typeNode && params) {
    const paramsEnd = params.endIndex;
    if (typeNode.startIndex > paramsEnd) return ` -> ${typeNode.text}`;
  }
  return "";
}

export function skeletonScala(filename: string, root: Node): string {
  const lines: string[] = [`# ${filename} [Scala]`];

  const imports: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type === "import_declaration") {
      const path_ = firstChildOfType(node, "stable_identifier", "identifier");
      if (path_) imports.push(path_.text);
    }
  }
  if (imports.length > 0) lines.push(`imports: ${imports.join(", ")}`);
  lines.push("");

  function processNode(node: Node, indent = ""): void {
    switch (node.type) {
      case "object_definition": {
        const name =
          childText(node, "name") || firstChildOfType(node, "identifier")?.text || "(anonymous)";
        lines.push(`${indent}object ${name}`);
        const body = node.childForFieldName("body") ?? firstChildOfType(node, "template_body");
        if (body) {
          for (const member of body.namedChildren) processNode(member, indent + "  ");
        }
        lines.push("");
        break;
      }
      case "class_definition": {
        const name =
          childText(node, "name") || firstChildOfType(node, "identifier")?.text || "(anonymous)";
        const isCaseClass = node.children.some((c) => !c.isNamed && c.type === "case");
        const keyword = isCaseClass ? "case class" : "class";
        lines.push(`${indent}${keyword} ${name}`);
        const body = node.childForFieldName("body") ?? firstChildOfType(node, "template_body");
        if (body) {
          for (const member of body.namedChildren) processNode(member, indent + "  ");
        }
        lines.push("");
        break;
      }
      case "trait_definition": {
        const name =
          childText(node, "name") || firstChildOfType(node, "identifier")?.text || "(anonymous)";
        lines.push(`${indent}trait ${name}`);
        const body = node.childForFieldName("body") ?? firstChildOfType(node, "template_body");
        if (body) {
          for (const member of body.namedChildren) processNode(member, indent + "  ");
        }
        lines.push("");
        break;
      }
      case "function_definition": {
        const name =
          childText(node, "name") || firstChildOfType(node, "identifier")?.text || "(anonymous)";
        const params = node.childForFieldName("parameters") ?? firstChildOfType(node, "parameters");
        const paramStr = extractScalaParams(params ?? null);
        const retStr = extractScalaReturnType(node);
        lines.push(`${indent}function ${name}(${paramStr})${retStr}`);
        break;
      }
      case "val_definition":
      case "var_definition": {
        const pattern = firstChildOfType(node, "identifier");
        const name = pattern?.text ?? childText(node, "pattern") ?? "";
        if (name) {
          const keyword = node.type === "val_definition" ? "val" : "var";
          const type_ = firstChildOfType(node, "type_identifier", "generic_type");
          const typeStr = type_ ? `: ${type_.text}` : "";
          lines.push(`${indent}${keyword} ${name}${typeStr}`);
        }
        break;
      }
      case "type_definition": {
        const name =
          childText(node, "name") || firstChildOfType(node, "identifier")?.text || "(anonymous)";
        const rhs = node.childForFieldName("type") ?? firstChildOfType(node, "type_identifier");
        lines.push(`${indent}type ${name}${rhs ? ` = ${rhs.text}` : ""}`);
        break;
      }
    }
  }

  for (const node of root.namedChildren) {
    processNode(node);
  }

  return lines.join("\n").trimEnd();
}
