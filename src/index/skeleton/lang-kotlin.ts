import type { Node } from "web-tree-sitter";
import { childText, childrenOfType, firstChildOfType } from "../skeleton-utils";

// ---------------------------------------------------------------------------
// Kotlin extractor
// ---------------------------------------------------------------------------

/** Kotlin names live in type_identifier or simple_identifier children, not field "name". */
function ktName(node: Node): string {
  return (
    firstChildOfType(node, "type_identifier", "simple_identifier")?.text ??
    childText(node, "name") ??
    ""
  );
}

/** Detect if a Kotlin class_declaration represents an interface (anonymous "interface" keyword). */
export function isKotlinInterface(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && c.type === "interface") return true;
  }
  return false;
}

/** Get the return type of a Kotlin function (user_type/nullable_type after function_value_parameters). */
function kotlinReturnType(node: Node): string {
  let afterParams = false;
  for (const c of node.namedChildren) {
    if (c.type === "function_value_parameters") {
      afterParams = true;
      continue;
    }
    if (afterParams && (c.type === "user_type" || c.type === "nullable_type")) {
      return c.text;
    }
  }
  return "";
}

function extractKotlinParams(params: Node | null): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const p of params.namedChildren) {
    if (p.type === "parameter") {
      const name = firstChildOfType(p, "simple_identifier");
      const type_ = firstChildOfType(p, "user_type", "nullable_type");
      parts.push(type_ ? `${name?.text ?? ""}: ${type_.text}` : (name?.text ?? p.text));
    }
  }
  return parts.join(", ");
}

function extractKotlinClass(node: Node): string[] {
  const lines: string[] = [];
  const name = ktName(node);
  const isData = node.children.some((c) => c.type === "modifiers" && c.text.includes("data"));
  const keyword = isKotlinInterface(node)
    ? "interface"
    : node.type === "object_declaration"
      ? "object"
      : isData
        ? "data class"
        : "class";
  lines.push(`${keyword} ${name}`);

  const body = firstChildOfType(node, "class_body");
  if (!body) return lines;

  for (const member of body.namedChildren) {
    if (member.type === "function_declaration") {
      const mName = ktName(member);
      const params = firstChildOfType(member, "function_value_parameters");
      const paramStr = extractKotlinParams(params);
      const retType = kotlinReturnType(member);
      const retStr = retType ? ` -> ${retType}` : "";
      const mods = firstChildOfType(member, "modifiers");
      const vis = mods?.text.includes("private") ? "-" : "+";
      lines.push(`  ${vis} ${mName}(${paramStr})${retStr}`);
    } else if (member.type === "companion_object") {
      lines.push("  companion object");
      const companionBody = firstChildOfType(member, "class_body");
      if (companionBody) {
        for (const cm of companionBody.namedChildren) {
          if (cm.type === "function_declaration") {
            const mName = ktName(cm);
            const params = firstChildOfType(cm, "function_value_parameters");
            const paramStr = extractKotlinParams(params);
            const retType = kotlinReturnType(cm);
            const retStr = retType ? ` -> ${retType}` : "";
            lines.push(`    + ${mName}(${paramStr})${retStr}`);
          }
        }
      }
    } else if (member.type === "property_declaration") {
      const varDecl = firstChildOfType(member, "variable_declaration");
      const propName = varDecl
        ? (firstChildOfType(varDecl, "simple_identifier")?.text ?? "")
        : ktName(member);
      if (propName) lines.push(`  + ${propName}`);
    }
  }

  return lines;
}

export function skeletonKotlin(filename: string, root: Node): string {
  const lines: string[] = [`# ${filename} [Kotlin]`];

  const imports: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type === "import_list") {
      for (const h of childrenOfType(node, "import_header")) {
        const id = firstChildOfType(h, "identifier");
        if (id) imports.push(id.text);
      }
    } else if (node.type === "import_header") {
      const id = firstChildOfType(node, "identifier");
      if (id) imports.push(id.text);
    }
  }
  if (imports.length > 0) lines.push(`imports: ${imports.join(", ")}`);
  lines.push("");

  for (const node of root.namedChildren) {
    if (node.type === "class_declaration" || node.type === "object_declaration") {
      lines.push(...extractKotlinClass(node));
      lines.push("");
    } else if (node.type === "function_declaration") {
      const name = ktName(node);
      const params = firstChildOfType(node, "function_value_parameters");
      const paramStr = extractKotlinParams(params);
      const retType = kotlinReturnType(node);
      const retStr = retType ? ` -> ${retType}` : "";
      lines.push(`function ${name}(${paramStr})${retStr}`);
      lines.push("");
    } else if (node.type === "property_declaration") {
      const varDecl = firstChildOfType(node, "variable_declaration");
      const name = varDecl
        ? (firstChildOfType(varDecl, "simple_identifier")?.text ?? "")
        : ktName(node);
      if (name) lines.push(`val ${name}`);
    }
  }

  return lines.join("\n").trimEnd();
}
