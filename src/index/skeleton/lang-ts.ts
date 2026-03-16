import type { Node } from "web-tree-sitter";
import { childText, firstChildOfType, childrenOfType } from "../skeleton-utils";
import { LANG_DISPLAY } from "./types";
import type { SupportedLanguage } from "./types";

// ---------------------------------------------------------------------------
// TypeScript / TSX / JavaScript extractor
// ---------------------------------------------------------------------------

function extractTsImports(root: Node): string[] {
  const imports: string[] = [];

  for (const node of root.namedChildren) {
    if (node.type === "import_statement") {
      const src = node.childForFieldName("source");
      if (src) imports.push(src.text.replace(/['"]/g, ""));
    } else if (node.type === "expression_statement") {
      const call = firstChildOfType(node, "call_expression");
      if (call) {
        const fn = call.childForFieldName("function");
        if (fn?.text === "require") {
          const args = call.childForFieldName("arguments");
          if (args) {
            const str = firstChildOfType(args, "string");
            if (str) imports.push(str.text.replace(/['"]/g, ""));
          }
        }
      }
    }
  }

  return imports;
}

function extractJsDocComment(node: Node): string | null {
  let sib = node.previousNamedSibling;
  while (sib) {
    if (sib.type === "comment") {
      const txt = sib.text;
      if (txt.startsWith("/**")) {
        const lines = txt
          .split("\n")
          .map((l) => l.replace(/^\s*\*+\s?/, "").trim())
          .filter((l) => l && !l.startsWith("@") && l !== "/");
        if (lines.length > 0)
          return lines[0]
            .replace(/^\/\*\*\s*/, "")
            .replace(/\*\/$/, "")
            .trim();
      }
      break;
    }
    if (!["comment"].includes(sib.type)) break;
    sib = sib.previousNamedSibling;
  }
  return null;
}

function extractTsParams(params: Node | null): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const child of params.namedChildren) {
    if (
      [
        "required_parameter",
        "optional_parameter",
        "rest_parameter",
        "identifier",
        "assignment_pattern",
        "object_pattern",
        "array_pattern",
      ].includes(child.type)
    ) {
      const name = child.childForFieldName("pattern") ?? child.childForFieldName("name") ?? child;
      const typeAnnotation = child.childForFieldName("type");
      const typeStr = typeAnnotation
        ? ": " + typeAnnotation.namedChildren.map((n) => n.text).join("")
        : "";
      parts.push(name.text.split("\n")[0] + typeStr);
    }
  }
  return parts.join(", ");
}

function extractTsReturnType(node: Node): string {
  const ret = node.childForFieldName("return_type");
  if (!ret) return "";
  return " -> " + ret.text.replace(/^:\s*/, "");
}

function methodVisibility(node: Node): string {
  for (const child of node.children) {
    if (child.type === "accessibility_modifier") {
      const txt = child.text;
      if (txt === "private" || txt === "protected") return "-";
      if (txt === "public") return "+";
    }
  }
  return "+";
}

function extractTsClass(node: Node): string[] {
  const lines: string[] = [];
  const name = childText(node, "name");
  lines.push(`class ${name}`);

  const body = node.childForFieldName("body");
  if (!body) return lines;

  for (const member of body.namedChildren) {
    if (
      member.type === "method_definition" ||
      member.type === "public_field_definition" ||
      member.type === "method_signature"
    ) {
      const mName = childText(member, "name");
      if (!mName) continue;
      const vis = methodVisibility(member);
      const params = member.childForFieldName("parameters");
      const paramStr = extractTsParams(params);
      const retStr = extractTsReturnType(member);
      const doc = extractJsDocComment(member);
      lines.push(`  ${vis} ${mName}(${paramStr})${retStr}`);
      if (doc) lines.push(`    """${doc}"""`);
    }
  }

  return lines;
}

function extractTsInterface(node: Node): string[] {
  const lines: string[] = [];
  const name = childText(node, "name");
  lines.push(`interface ${name}`);

  const body = node.childForFieldName("body");
  if (!body) return lines;

  for (const member of body.namedChildren) {
    if (member.type === "method_signature" || member.type === "property_signature") {
      const mName = childText(member, "name");
      if (!mName) continue;
      if (member.type === "method_signature") {
        const params = member.childForFieldName("parameters");
        const paramStr = extractTsParams(params);
        const retStr = extractTsReturnType(member);
        lines.push(`  + ${mName}(${paramStr})${retStr}`);
      } else {
        const typeAnnotation = member.childForFieldName("type");
        const typeStr = typeAnnotation ? `: ${typeAnnotation.text.replace(/^:\s*/, "")}` : "";
        lines.push(`  + ${mName}${typeStr}`);
      }
    }
  }

  return lines;
}

function extractTsFunction(node: Node): string {
  const name =
    childText(node, "name") ||
    node.childForFieldName("name")?.text ||
    (node.type === "variable_declarator" ? childText(node, "name") : "");
  const params = node.childForFieldName("parameters");
  const paramStr = extractTsParams(params);
  const retStr = extractTsReturnType(node);
  return `function ${name}(${paramStr})${retStr}`;
}

export function skeletonTypeScript(filename: string, root: Node, lang: SupportedLanguage): string {
  const displayLang = LANG_DISPLAY[lang];
  const lines: string[] = [`# ${filename} [${displayLang}]`];

  const imports = extractTsImports(root);
  if (imports.length > 0) {
    lines.push(`imports: ${imports.join(", ")}`);
  }

  lines.push("");

  function emitTsDecl(node: Node): void {
    switch (node.type) {
      case "class_declaration":
      case "abstract_class_declaration": {
        lines.push(...extractTsClass(node));
        lines.push("");
        break;
      }
      case "function_declaration":
      case "function": {
        const doc = extractJsDocComment(node);
        lines.push(extractTsFunction(node));
        if (doc) lines.push(`  """${doc}"""`);
        lines.push("");
        break;
      }
      case "interface_declaration": {
        lines.push(...extractTsInterface(node));
        lines.push("");
        break;
      }
      case "type_alias_declaration": {
        const name = childText(node, "name");
        const value = node.childForFieldName("value");
        lines.push(`type ${name} = ${value?.text ?? "unknown"}`);
        lines.push("");
        break;
      }
      case "enum_declaration": {
        const name = childText(node, "name");
        const body = node.childForFieldName("body");
        const members = body
          ? childrenOfType(body, "enum_assignment", "property_identifier").map(
              (m) => childText(m, "name") || m.text.split("=")[0].trim(),
            )
          : [];
        lines.push(`enum ${name}`);
        if (members.length > 0) lines.push(`  members: ${members.join(", ")}`);
        lines.push("");
        break;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        for (const declarator of childrenOfType(node, "variable_declarator")) {
          const val = declarator.childForFieldName("value");
          if (val && (val.type === "arrow_function" || val.type === "function")) {
            const name = childText(declarator, "name");
            const params = val.childForFieldName("parameters");
            const paramStr = extractTsParams(params);
            const retStr = extractTsReturnType(val);
            lines.push(`function ${name}(${paramStr})${retStr}`);
            lines.push("");
          }
        }
        break;
      }
    }
  }

  for (const node of root.namedChildren) {
    if (node.type === "export_statement") {
      const decl = node.childForFieldName("declaration");
      if (decl) emitTsDecl(decl);
    } else {
      emitTsDecl(node);
    }
  }

  return lines.join("\n").trimEnd();
}
