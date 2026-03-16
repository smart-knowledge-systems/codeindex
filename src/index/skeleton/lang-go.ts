import type { Node } from "web-tree-sitter";
import { childText, childrenOfType, descendantsOfType, nodeText } from "../skeleton-utils";

// ---------------------------------------------------------------------------
// Go extractor
// ---------------------------------------------------------------------------

function extractGoParams(params: Node): string {
  const parts: string[] = [];
  for (const p of params.namedChildren) {
    if (p.type === "parameter_declaration") {
      const names = childrenOfType(p, "identifier").map((n) => nodeText(n));
      const type_ = p.childForFieldName("type");
      const typeStr = type_ ? type_.text : "";
      if (names.length > 0) parts.push(`${names.join(", ")} ${typeStr}`.trim());
      else parts.push(typeStr);
    } else if (p.type === "variadic_parameter_declaration") {
      const name = p.childForFieldName("name");
      const type_ = p.childForFieldName("type");
      parts.push(`${name?.text ?? ""}...${type_?.text ?? ""}`);
    }
  }
  return parts.join(", ");
}

export function skeletonGo(filename: string, root: Node): string {
  const lines: string[] = [`# ${filename} [Go]`];

  const imports: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type === "import_declaration") {
      for (const spec of descendantsOfType(node, ["import_spec"])) {
        const path_ = spec.childForFieldName("path");
        if (path_) imports.push(path_.text.replace(/['"]/g, ""));
      }
    }
  }
  if (imports.length > 0) lines.push(`imports: ${imports.join(", ")}`);
  lines.push("");

  for (const node of root.namedChildren) {
    switch (node.type) {
      case "type_declaration": {
        for (const spec of childrenOfType(node, "type_spec")) {
          const name = childText(spec, "name");
          const type_ = spec.childForFieldName("type");
          if (type_?.type === "struct_type") {
            lines.push(`struct ${name}`);
            lines.push("");
          } else if (type_?.type === "interface_type") {
            lines.push(`interface ${name}`);
            const body = type_.childForFieldName("body");
            if (body) {
              for (const method of childrenOfType(body, "method_elem")) {
                const mName = childText(method, "name");
                const params = method.childForFieldName("parameters");
                const paramStr = params ? extractGoParams(params) : "";
                const result = method.childForFieldName("result");
                const retStr = result ? ` -> ${result.text}` : "";
                lines.push(`  + ${mName}(${paramStr})${retStr}`);
              }
            }
            lines.push("");
          }
        }
        break;
      }
      case "function_declaration": {
        const name = childText(node, "name");
        const params = node.childForFieldName("parameters");
        const paramStr = params ? extractGoParams(params) : "";
        const result = node.childForFieldName("result");
        const retStr = result ? ` -> ${result.text}` : "";
        lines.push(`function ${name}(${paramStr})${retStr}`);
        lines.push("");
        break;
      }
      case "method_declaration": {
        const recv = node.childForFieldName("receiver");
        const recvType = recv ? extractGoParams(recv) : "";
        const name = childText(node, "name");
        const params = node.childForFieldName("parameters");
        const paramStr = params ? extractGoParams(params) : "";
        const result = node.childForFieldName("result");
        const retStr = result ? ` -> ${result.text}` : "";
        lines.push(`function (${recvType}) ${name}(${paramStr})${retStr}`);
        lines.push("");
        break;
      }
      case "const_declaration":
      case "var_declaration": {
        const keyword = node.type === "const_declaration" ? "const" : "var";
        const specs = childrenOfType(node, "const_spec", "var_spec");
        if (specs.length > 0) {
          const names = specs
            .map((s) => childText(s, "name") || s.namedChildren[0]?.text || "")
            .filter(Boolean);
          if (names.length > 0) {
            lines.push(`${keyword} (${names.join(", ")})`);
            lines.push("");
          }
        }
        break;
      }
    }
  }

  return lines.join("\n").trimEnd();
}
