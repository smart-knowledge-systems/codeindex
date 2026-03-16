import type { Node } from "web-tree-sitter";
import { childText, childrenOfType, firstChildOfType } from "../skeleton-utils";

// ---------------------------------------------------------------------------
// C# extractor
// ---------------------------------------------------------------------------

function collectCsAttributes(node: Node): string[] {
  const attrs: string[] = [];
  for (const child of childrenOfType(node, "attribute_list")) {
    attrs.push(child.text.trim());
  }
  let sib = node.previousNamedSibling;
  while (sib && sib.type === "attribute_list") {
    attrs.unshift(sib.text.trim());
    sib = sib.previousNamedSibling;
  }
  return attrs;
}

function extractCsParams(params: Node | null): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const p of params.namedChildren) {
    if (p.type === "parameter") {
      const type_ = p.childForFieldName("type");
      const name = p.childForFieldName("name") ?? p.childForFieldName("identifier");
      parts.push(type_ ? `${name?.text ?? ""}: ${type_.text}` : (name?.text ?? p.text));
    }
  }
  return parts.join(", ");
}

export function skeletonCSharp(filename: string, root: Node): string {
  const lines: string[] = [`# ${filename} [C#]`];

  const usings: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type === "using_directive") {
      const name = node.namedChildren.find(
        (c) => c.type === "qualified_name" || c.type === "identifier",
      );
      if (name) usings.push(name.text);
    }
  }
  if (usings.length > 0) lines.push(`imports: ${usings.join(", ")}`);
  lines.push("");

  function processNs(node: Node): void {
    for (const child of node.namedChildren) {
      if (
        child.type === "namespace_declaration" ||
        child.type === "file_scoped_namespace_declaration"
      ) {
        const body = child.childForFieldName("body") ?? child.childForFieldName("declaration_list");
        const members = body ? body.namedChildren : child.namedChildren;
        for (const ns_child of members) {
          processMember(ns_child);
        }
      } else {
        processMember(child);
      }
    }
  }

  function processMember(node: Node): void {
    if (
      node.type === "class_declaration" ||
      node.type === "interface_declaration" ||
      node.type === "struct_declaration"
    ) {
      const attrs = collectCsAttributes(node);
      for (const attr of attrs) lines.push(attr);
      const name = childText(node, "name");
      const keyword =
        node.type === "interface_declaration"
          ? "interface"
          : node.type === "struct_declaration"
            ? "struct"
            : "class";
      lines.push(`${keyword} ${name}`);
      const body = node.childForFieldName("body") ?? firstChildOfType(node, "declaration_list");
      if (body) {
        for (const member of body.namedChildren) {
          if (member.type === "method_declaration" || member.type === "constructor_declaration") {
            const mName = childText(member, "name");
            const params = member.childForFieldName("parameter_list");
            const paramStr = extractCsParams(params ?? null);
            const retType = member.childForFieldName("type");
            const retStr = retType ? ` -> ${retType.text}` : "";
            const mods = member.childForFieldName("modifier");
            const modText = mods?.text ?? "";
            const vis = modText.includes("private") ? "-" : "+";
            const memberAttrs = collectCsAttributes(member);
            for (const attr of memberAttrs) lines.push(`  ${attr}`);
            lines.push(`  ${vis} ${mName}(${paramStr})${retStr}`);
          } else if (member.type === "property_declaration") {
            const propName = childText(member, "name");
            const propType = member.childForFieldName("type");
            const propTypeStr = propType ? `: ${propType.text}` : "";
            lines.push(`  + ${propName}${propTypeStr}`);
          }
        }
      }
      lines.push("");
    }
  }

  processNs(root);

  return lines.join("\n").trimEnd();
}
