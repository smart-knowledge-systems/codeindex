import type { Node } from "web-tree-sitter";
import { childText, childrenOfType } from "../skeleton-utils";

// ---------------------------------------------------------------------------
// Java extractor
// ---------------------------------------------------------------------------

function extractJavaDoc(node: Node): string | null {
  let sib = node.previousNamedSibling;
  while (sib) {
    if (sib.type === "block_comment") {
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
    if (sib.type !== "block_comment" && sib.type !== "line_comment") break;
    sib = sib.previousNamedSibling;
  }
  return null;
}

function extractJavaParams(params: Node | null): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const p of params.namedChildren) {
    if (p.type === "formal_parameter" || p.type === "spread_parameter") {
      const type_ = p.childForFieldName("type");
      const name = p.childForFieldName("name") ?? p.childForFieldName("dimensions");
      parts.push(type_ ? `${name?.text ?? ""}: ${type_.text}` : (name?.text ?? p.text));
    }
  }
  return parts.join(", ");
}

function extractJavaAnnotations(node: Node): string[] {
  return childrenOfType(node, "marker_annotation", "annotation").map((a) =>
    a.text.split("\n")[0].trim(),
  );
}

function extractJavaClass(node: Node): string[] {
  const lines: string[] = [];
  const name = childText(node, "name");
  const keyword = node.type === "interface_declaration" ? "interface" : "class";
  lines.push(`${keyword} ${name}`);

  const body = node.childForFieldName("body");
  if (!body) return lines;

  for (const member of body.namedChildren) {
    if (member.type === "method_declaration" || member.type === "constructor_declaration") {
      const mName = childText(member, "name");
      const params =
        member.childForFieldName("parameters") ?? member.childForFieldName("formal_parameters");
      const paramStr = extractJavaParams(params ?? null);
      const retType = member.childForFieldName("type");
      const retStr = retType ? ` -> ${retType.text}` : "";
      const mods = childrenOfType(member, "modifiers");
      const modText = mods.map((m) => m.text).join(" ");
      const vis = modText.includes("private") ? "-" : "+";
      const annotations = mods.flatMap((m) => extractJavaAnnotations(m));
      const doc = extractJavaDoc(member);
      for (const ann of annotations) lines.push(`  ${ann}`);
      lines.push(`  ${vis} ${mName}(${paramStr})${retStr}`);
      if (doc) lines.push(`    """${doc}"""`);
    }
  }

  return lines;
}

export function skeletonJava(filename: string, root: Node): string {
  const lines: string[] = [`# ${filename} [Java]`];

  const imports: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type === "import_declaration") {
      const name = node.namedChildren.find(
        (c) => c.type === "scoped_identifier" || c.type === "identifier",
      );
      if (name) imports.push(name.text);
    }
  }
  if (imports.length > 0) lines.push(`imports: ${imports.join(", ")}`);
  lines.push("");

  for (const node of root.namedChildren) {
    if (
      node.type === "class_declaration" ||
      node.type === "interface_declaration" ||
      node.type === "enum_declaration"
    ) {
      const mods = childrenOfType(node, "modifiers");
      const annotations = mods.flatMap((m) => extractJavaAnnotations(m));
      for (const ann of annotations) lines.push(ann);
      lines.push(...extractJavaClass(node));
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}
