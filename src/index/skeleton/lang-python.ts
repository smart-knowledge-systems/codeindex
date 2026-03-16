import type { Node } from "web-tree-sitter";
import { childText, childrenOfType, descendantsOfType } from "../skeleton-utils";

// ---------------------------------------------------------------------------
// Python extractor
// ---------------------------------------------------------------------------

function extractPyDocstring(node: Node): string | null {
  const body = node.childForFieldName("body");
  if (!body) return null;
  const first = body.namedChildren[0];
  if (!first || first.type !== "expression_statement") return null;
  const expr = first.namedChildren[0];
  if (!expr || expr.type !== "string") return null;
  const txt = expr.text
    .replace(/^"""|"""$/g, "")
    .replace(/^'''|'''$/g, "")
    .trim();
  return txt.split("\n")[0].trim();
}

function extractPyParams(params: Node | null): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const p of params.namedChildren) {
    if (p.type === "identifier") {
      parts.push(p.text);
    } else if (p.type === "typed_parameter" || p.type === "typed_default_parameter") {
      const name = p.namedChildren[0]?.text ?? "";
      const typeNode = p.childForFieldName("type");
      parts.push(typeNode ? `${name}: ${typeNode.text}` : name);
    } else if (
      p.type === "default_parameter" ||
      p.type === "list_splat_pattern" ||
      p.type === "dictionary_splat_pattern"
    ) {
      parts.push(p.text.split("\n")[0]);
    }
  }
  return parts.filter((p) => p !== "self" && p !== "cls").join(", ");
}

function extractPyReturnAnnotation(node: Node): string {
  const ret = node.childForFieldName("return_type");
  if (!ret) return "";
  return ` -> ${ret.text}`;
}

function extractPyDecorators(node: Node): string[] {
  return childrenOfType(node, "decorator").map((d) => d.text.split("\n")[0].trim());
}

function extractPyClass(node: Node): string[] {
  const lines: string[] = [];
  const name = childText(node, "name");
  lines.push(`class ${name}`);

  const doc = extractPyDocstring(node);
  if (doc) lines.push(`  """${doc}"""`);

  const body = node.childForFieldName("body");
  if (!body) return lines;

  for (const child of body.namedChildren) {
    let funcNode = child;
    let decorators: string[] = [];
    if (child.type === "decorated_definition") {
      decorators = extractPyDecorators(child);
      funcNode = child.namedChildren.find((c) => c.type === "function_definition") ?? child;
    }
    if (funcNode.type === "function_definition") {
      const mName = childText(funcNode, "name");
      const params = funcNode.childForFieldName("parameters");
      const paramStr = extractPyParams(params);
      const retStr = extractPyReturnAnnotation(funcNode);
      const vis = mName.startsWith("_") && !mName.startsWith("__") ? "-" : "+";
      const mDoc = extractPyDocstring(funcNode);
      for (const dec of decorators) lines.push(`  ${dec}`);
      lines.push(`  ${vis} ${mName}(${paramStr})${retStr}`);
      if (mDoc) lines.push(`    """${mDoc}"""`);
    }
  }

  return lines;
}

export function skeletonPython(filename: string, root: Node): string {
  const lines: string[] = [`# ${filename} [Python]`];

  const imports: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type === "import_statement") {
      const names = descendantsOfType(node, ["dotted_name", "identifier"]);
      if (names.length > 0) imports.push(names[0].text);
    } else if (node.type === "import_from_statement") {
      const mod = node.childForFieldName("module_name");
      if (mod) imports.push(mod.text);
    }
  }

  if (imports.length > 0) lines.push(`imports: ${imports.join(", ")}`);
  lines.push("");

  // Module-level docstring
  const first = root.namedChildren[0];
  if (first?.type === "expression_statement") {
    const expr = first.namedChildren[0];
    if (expr?.type === "string") {
      const doc = expr.text
        .replace(/^"""|"""$/g, "")
        .replace(/^'''|'''$/g, "")
        .trim()
        .split("\n")[0]
        .trim();
      if (doc) lines.push(`"""${doc}"""\n`);
    }
  }

  function emitPyDecl(node: Node, decorators: string[] = []): void {
    if (node.type === "class_definition") {
      for (const dec of decorators) lines.push(dec);
      lines.push(...extractPyClass(node));
      lines.push("");
    } else if (node.type === "function_definition") {
      const name = childText(node, "name");
      const params = node.childForFieldName("parameters");
      const paramStr = extractPyParams(params);
      const retStr = extractPyReturnAnnotation(node);
      for (const dec of decorators) lines.push(dec);
      lines.push(`function ${name}(${paramStr})${retStr}`);
      const doc = extractPyDocstring(node);
      if (doc) lines.push(`  """${doc}"""`);
      lines.push("");
    }
  }

  for (const node of root.namedChildren) {
    if (node.type === "decorated_definition") {
      const decorators = extractPyDecorators(node);
      const definition = node.namedChildren.find(
        (c) => c.type === "class_definition" || c.type === "function_definition",
      );
      if (definition) emitPyDecl(definition, decorators);
    } else {
      emitPyDecl(node);
    }
  }

  return lines.join("\n").trimEnd();
}
