import type { Node } from "web-tree-sitter";
import { childText, childrenOfType } from "../skeleton-utils";

// ---------------------------------------------------------------------------
// Rust extractor
// ---------------------------------------------------------------------------

function collectRustAttributes(node: Node): string[] {
  const attrs: string[] = [];
  let sib = node.previousNamedSibling;
  while (sib && sib.type === "attribute_item") {
    attrs.unshift(sib.text.trim());
    sib = sib.previousNamedSibling;
  }
  return attrs;
}

function extractRustParams(params: Node): string {
  const parts: string[] = [];
  for (const p of params.namedChildren) {
    if (p.type === "parameter") {
      const pat = p.childForFieldName("pattern");
      const ty = p.childForFieldName("type");
      if (pat && ty) parts.push(`${pat.text}: ${ty.text}`);
      else if (pat) parts.push(pat.text);
    } else if (p.type === "self_parameter" || p.type === "variadic_parameter") {
      parts.push(p.text);
    }
  }
  return parts.join(", ");
}

export function skeletonRust(filename: string, root: Node): string {
  const lines: string[] = [`# ${filename} [Rust]`];

  const uses: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type === "use_declaration") {
      const arg = node.childForFieldName("argument");
      if (arg) uses.push(arg.text);
    }
  }
  if (uses.length > 0) lines.push(`imports: ${uses.join(", ")}`);
  lines.push("");

  for (const node of root.namedChildren) {
    switch (node.type) {
      case "struct_item": {
        const name = childText(node, "name");
        for (const attr of collectRustAttributes(node)) lines.push(attr);
        lines.push(`struct ${name}`);
        lines.push("");
        break;
      }
      case "enum_item": {
        const name = childText(node, "name");
        const body = node.childForFieldName("body");
        const variants = body
          ? childrenOfType(body, "enum_variant").map((v) => childText(v, "name"))
          : [];
        for (const attr of collectRustAttributes(node)) lines.push(attr);
        lines.push(`enum ${name}`);
        if (variants.length > 0) lines.push(`  variants: ${variants.join(", ")}`);
        lines.push("");
        break;
      }
      case "trait_item": {
        const name = childText(node, "name");
        lines.push(`trait ${name}`);
        const body = node.childForFieldName("body");
        if (body) {
          for (const item of body.namedChildren) {
            if (item.type === "function_signature_item" || item.type === "function_item") {
              const fnName = childText(item, "name");
              const params = item.childForFieldName("parameters");
              const paramStr = params ? extractRustParams(params) : "";
              const ret = item.childForFieldName("return_type");
              const retStr = ret ? ` -> ${ret.text}` : "";
              lines.push(`  + ${fnName}(${paramStr})${retStr}`);
            }
          }
        }
        lines.push("");
        break;
      }
      case "impl_item": {
        const type = node.childForFieldName("type");
        const trait = node.childForFieldName("trait");
        const header = trait
          ? `impl ${trait.text} for ${type?.text ?? ""}`
          : `impl ${type?.text ?? ""}`;
        lines.push(header);
        const body = node.childForFieldName("body");
        if (body) {
          for (const item of body.namedChildren) {
            if (item.type === "function_item") {
              const fnName = childText(item, "name");
              const params = item.childForFieldName("parameters");
              const paramStr = params ? extractRustParams(params) : "";
              const ret = item.childForFieldName("return_type");
              const retStr = ret ? ` -> ${ret.text}` : "";
              const vis = item.childForFieldName("visibility_modifier");
              const visStr = vis?.text === "pub" ? "+" : "-";
              lines.push(`  ${visStr} ${fnName}(${paramStr})${retStr}`);
            }
          }
        }
        lines.push("");
        break;
      }
      case "function_item": {
        const fnName = childText(node, "name");
        const params = node.childForFieldName("parameters");
        const paramStr = params ? extractRustParams(params) : "";
        const ret = node.childForFieldName("return_type");
        const retStr = ret ? ` -> ${ret.text}` : "";
        for (const attr of collectRustAttributes(node)) lines.push(attr);
        lines.push(`function ${fnName}(${paramStr})${retStr}`);
        lines.push("");
        break;
      }
    }
  }

  return lines.join("\n").trimEnd();
}
