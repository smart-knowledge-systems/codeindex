import type { Node } from "web-tree-sitter";
import { firstChildOfType } from "../skeleton-utils";
import { LANG_DISPLAY } from "./types";
import type { SupportedLanguage } from "./types";

// ---------------------------------------------------------------------------
// C / C++ extractor
// ---------------------------------------------------------------------------

function extractCParams(params: Node): string {
  const parts: string[] = [];
  for (const p of params.namedChildren) {
    if (p.type === "parameter_declaration") {
      const type_ = p.childForFieldName("type");
      const decl = p.childForFieldName("declarator");
      const name = decl?.text ?? "";
      parts.push(type_ ? `${name}: ${type_.text}`.trim() : name);
    } else if (p.type === "variadic_parameter") {
      parts.push("...");
    }
  }
  return parts.join(", ");
}

function extractCFunctionSignature(node: Node): string | null {
  function getFuncDeclarator(n: Node): Node | null {
    if (n.type === "function_declarator") return n;
    for (const child of n.namedChildren) {
      const found = getFuncDeclarator(child);
      if (found) return found;
    }
    return null;
  }

  const decl = node.childForFieldName("declarator") ?? node;
  const funcDecl = getFuncDeclarator(decl);
  if (!funcDecl) return null;

  const nameNode = funcDecl.childForFieldName("declarator");
  const params = funcDecl.childForFieldName("parameters");
  const name = nameNode?.text ?? "";
  const retType = node.childForFieldName("type");
  const retStr = retType ? ` -> ${retType.text}` : "";
  const paramStr = params ? extractCParams(params) : "";
  return `${name}(${paramStr})${retStr}`;
}

export function skeletonC(filename: string, root: Node, lang: SupportedLanguage): string {
  const displayLang = LANG_DISPLAY[lang];
  const lines: string[] = [`# ${filename} [${displayLang}]`];

  const includes: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type === "preproc_include") {
      const path_ =
        node.childForFieldName("path") ??
        firstChildOfType(node, "string_literal", "system_lib_string");
      if (path_) includes.push(path_.text.replace(/[<>"]/g, ""));
    }
  }
  if (includes.length > 0) lines.push(`imports: ${includes.join(", ")}`);
  lines.push("");

  function processNode(node: Node, indent = ""): void {
    switch (node.type) {
      case "struct_specifier":
      case "class_specifier": {
        const name = node.childForFieldName("name");
        const keyword = node.type === "struct_specifier" ? "struct" : "class";
        if (name) {
          lines.push(`${indent}${keyword} ${name.text}`);
          const body = node.childForFieldName("body");
          if (body) {
            for (const member of body.namedChildren) {
              processNode(member, indent + "  ");
            }
          }
          lines.push("");
        }
        break;
      }
      case "namespace_definition": {
        const name = node.childForFieldName("name");
        lines.push(`${indent}namespace ${name?.text ?? "(anonymous)"}`);
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            processNode(child, indent + "  ");
          }
        }
        lines.push("");
        break;
      }
      case "function_definition": {
        const fnText = extractCFunctionSignature(node);
        if (fnText) {
          lines.push(`${indent}function ${fnText}`);
          lines.push("");
        }
        break;
      }
      case "declaration": {
        const decl = node.childForFieldName("declarator");
        if (decl?.type === "function_declarator") {
          const fnText = extractCFunctionSignature(node);
          if (fnText) {
            lines.push(`${indent}function ${fnText}`);
            lines.push("");
          }
        }
        break;
      }
      case "template_declaration": {
        const params = node.childForFieldName("parameters");
        const paramStr = params ? params.text : "";
        for (const child of node.namedChildren) {
          if (child.type === "function_definition" || child.type === "declaration") {
            const fnText = extractCFunctionSignature(child);
            if (fnText) {
              lines.push(`${indent}template${paramStr}`);
              lines.push(`${indent}function ${fnText}`);
              lines.push("");
            }
          } else if (child.type === "class_specifier" || child.type === "struct_specifier") {
            const name = child.childForFieldName("name");
            if (name) {
              const kw = child.type === "class_specifier" ? "class" : "struct";
              lines.push(`${indent}template${paramStr}`);
              lines.push(`${indent}${kw} ${name.text}`);
              lines.push("");
            }
          }
        }
        break;
      }
      case "type_definition": {
        const declarator = node.childForFieldName("declarator");
        const type = node.childForFieldName("type");
        if (declarator) {
          const name = declarator.text;
          if (
            type &&
            (type.type === "struct_specifier" ||
              type.type === "union_specifier" ||
              type.type === "enum_specifier")
          ) {
            const kw = type.type.replace("_specifier", "");
            lines.push(`${indent}typedef ${kw} ${name}`);
          } else {
            const typeStr = type ? type.text : "";
            lines.push(`${indent}typedef ${typeStr} ${name}`);
          }
          lines.push("");
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
