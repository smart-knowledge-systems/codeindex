import path from "path";
import { Parser, Language, type Node } from "web-tree-sitter";
import type { SkeletonEntry } from "../search/types";

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

let parserInitialised = false;
const languageCache = new Map<string, Language>();

export async function initParser(): Promise<void> {
  if (parserInitialised) return;
  await Parser.init();
  parserInitialised = true;
}

// ---------------------------------------------------------------------------
// Extension → language name mapping
// ---------------------------------------------------------------------------

type SupportedLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "c"
  | "cpp"
  | "c_sharp";

const EXT_TO_LANG: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".h": "c",
  ".cs": "c_sharp",
};

const LANG_DISPLAY: Record<SupportedLanguage, string> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  c: "C",
  cpp: "C++",
  c_sharp: "C#",
};

const WASM_DIR = path.join(import.meta.dir, "../../node_modules/tree-sitter-wasms/out");

async function loadLanguage(lang: SupportedLanguage): Promise<Language> {
  const cached = languageCache.get(lang);
  if (cached) return cached;

  const wasmPath = path.join(WASM_DIR, `tree-sitter-${lang}.wasm`);
  const language = await Language.load(wasmPath);
  languageCache.set(lang, language);
  return language;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstNLines(content: string, n: number): string {
  return content.split("\n").slice(0, n).join("\n");
}

function childText(node: Node, fieldName: string): string {
  return node.childForFieldName(fieldName)?.text ?? "";
}

function nodeText(node: Node): string {
  return node.text;
}

/** Return the text of the first child whose type matches one of the given types. */
function firstChildOfType(node: Node, ...types: string[]): Node | null {
  for (const child of node.children) {
    if (types.includes(child.type)) return child;
  }
  return null;
}

/** Collect immediate named children with a given type. */
function childrenOfType(node: Node, ...types: string[]): Node[] {
  return node.namedChildren.filter((c) => types.includes(c.type));
}

/** Walk all descendants (breadth-first) matching a type set. */
function descendantsOfType(node: Node, types: string[]): Node[] {
  return node.descendantsOfType(types);
}

// ---------------------------------------------------------------------------
// TypeScript / TSX / JavaScript extractor
// ---------------------------------------------------------------------------

function extractTsImports(root: Node): string[] {
  const imports: string[] = [];

  for (const node of root.namedChildren) {
    if (node.type === "import_statement") {
      // import ... from 'source'
      const src = node.childForFieldName("source");
      if (src) imports.push(src.text.replace(/['"]/g, ""));
    } else if (node.type === "expression_statement") {
      // require('...')
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
  // Walk backwards through siblings to find an immediately preceding comment
  let sib = node.previousNamedSibling;
  while (sib) {
    if (sib.type === "comment") {
      const txt = sib.text;
      if (txt.startsWith("/**")) {
        // Extract first meaningful line of JSDoc
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
  // params node: formal_parameters / parameter_list / arguments
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
  // Look for accessibility modifiers
  for (const child of node.children) {
    if (child.type === "accessibility_modifier") {
      const txt = child.text;
      if (txt === "private" || txt === "protected") return "-";
      if (txt === "public") return "+";
    }
  }
  // Static methods with no explicit modifier - treat as '+'
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

function skeletonTypeScript(filename: string, root: Node, lang: SupportedLanguage): string {
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

// ---------------------------------------------------------------------------
// Python extractor
// ---------------------------------------------------------------------------

function extractPyDocstring(node: Node): string | null {
  // First statement of a function/class body may be an expression_statement with a string
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

function skeletonPython(filename: string, root: Node): string {
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

function skeletonRust(filename: string, root: Node): string {
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

// ---------------------------------------------------------------------------
// Go extractor
// ---------------------------------------------------------------------------

function skeletonGo(filename: string, root: Node): string {
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
    }
  }

  return lines.join("\n").trimEnd();
}

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
      // Check for private modifier
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

function skeletonJava(filename: string, root: Node): string {
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

// ---------------------------------------------------------------------------
// C / C++ extractor
// ---------------------------------------------------------------------------

function skeletonC(filename: string, root: Node, lang: SupportedLanguage): string {
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
        const decl = node.childForFieldName("declarator");
        if (!decl) break;
        const fnText = extractCFunctionSignature(node);
        if (fnText) {
          lines.push(`${indent}function ${fnText}`);
          lines.push("");
        }
        break;
      }
      case "declaration": {
        // Could be a function declaration (prototype)
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
    }
  }

  for (const node of root.namedChildren) {
    processNode(node);
  }

  return lines.join("\n").trimEnd();
}

function extractCFunctionSignature(node: Node): string | null {
  // Find the function name by traversing the declarator chain
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

// ---------------------------------------------------------------------------
// C# extractor
// ---------------------------------------------------------------------------

function collectCsAttributes(node: Node): string[] {
  const attrs: string[] = [];
  // Check child attribute_list nodes (C# grammar embeds attributes as children)
  for (const child of childrenOfType(node, "attribute_list")) {
    attrs.push(child.text.trim());
  }
  // Also check previous siblings
  let sib = node.previousNamedSibling;
  while (sib && sib.type === "attribute_list") {
    attrs.unshift(sib.text.trim());
    sib = sib.previousNamedSibling;
  }
  return attrs;
}

function skeletonCSharp(filename: string, root: Node): string {
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
      // Emit attribute_list nodes that precede the declaration
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

// ---------------------------------------------------------------------------
// Main exported functions
// ---------------------------------------------------------------------------

export async function extractSkeleton(
  filePath: string,
  content: string,
  fallbackLines = 50,
): Promise<string> {
  const result = await extractSkeletonWithEntries(filePath, content, fallbackLines);
  return result.text;
}

export interface SkeletonResult {
  text: string;
  entries: SkeletonEntry[];
}

/** Extract entries (name, kind, startLine, endLine) from a tree-sitter AST root. */
function collectEntries(root: Node): SkeletonEntry[] {
  const entries: SkeletonEntry[] = [];

  function getFuncNameFromDeclarator(n: Node): string {
    if (n.type === "function_declarator") {
      return n.childForFieldName("declarator")?.text ?? "(anonymous)";
    }
    for (const child of n.namedChildren) {
      const found = getFuncNameFromDeclarator(child);
      if (found !== "(anonymous)") return found;
    }
    return "(anonymous)";
  }

  function collectMethodsFromBody(body: Node): void {
    for (const member of body.namedChildren) {
      if (
        member.type === "method_definition" ||
        member.type === "method_signature" ||
        member.type === "method_declaration" ||
        member.type === "constructor_declaration"
      ) {
        const mName = member.childForFieldName("name")?.text;
        if (mName) {
          entries.push({
            name: mName,
            kind: "method",
            startLine: member.startPosition.row + 1,
            endLine: member.endPosition.row + 1,
          });
        }
      }
    }
  }

  function walk(node: Node): void {
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    switch (node.type) {
      // Functions: TS/JS/Go function_declaration, TS function
      case "function_declaration":
      case "function": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        entries.push({ name, kind: "function", startLine, endLine });
        return;
      }

      // Python/C/C++ function_definition
      case "function_definition": {
        // C/C++ path: has declarator field
        const decl = node.childForFieldName("declarator");
        if (
          decl &&
          (decl.type === "function_declarator" ||
            decl.namedChildren.some((c) => c.type === "function_declarator"))
        ) {
          entries.push({
            name: getFuncNameFromDeclarator(decl),
            kind: "function",
            startLine,
            endLine,
          });
        } else {
          // Python path
          const name = node.childForFieldName("name")?.text ?? "(anonymous)";
          const parent = node.parent;
          const kind =
            parent?.type === "block" && parent.parent?.type === "class_definition"
              ? "method"
              : "function";
          entries.push({ name, kind, startLine, endLine });
        }
        return;
      }

      // Classes: TS/JS/Java/C#
      case "class_declaration":
      case "abstract_class_declaration":
      case "interface_declaration":
      case "enum_declaration":
      case "struct_declaration": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        const kind = node.type.replace("_declaration", "").replace("abstract_", "");
        entries.push({ name, kind, startLine, endLine });
        const body = node.childForFieldName("body") ?? node.childForFieldName("declaration_list");
        if (body) collectMethodsFromBody(body);
        return;
      }

      // TS type alias
      case "type_alias_declaration": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        entries.push({ name, kind: "type", startLine, endLine });
        return;
      }

      // Python decorated definition
      case "decorated_definition": {
        const definition = node.namedChildren.find(
          (c) => c.type === "class_definition" || c.type === "function_definition",
        );
        if (definition) walk(definition);
        return;
      }

      // Python class
      case "class_definition": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        entries.push({ name, kind: "class", startLine, endLine });
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            if (child.type === "function_definition") walk(child);
          }
        }
        return;
      }

      // Go method
      case "method_declaration": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        entries.push({ name, kind: "method", startLine, endLine });
        return;
      }

      // Go type declarations
      case "type_declaration": {
        for (const spec of node.namedChildren) {
          if (spec.type === "type_spec") {
            const name = spec.childForFieldName("name")?.text ?? "(anonymous)";
            const type_ = spec.childForFieldName("type");
            const kind = type_?.type === "interface_type" ? "interface" : "struct";
            entries.push({
              name,
              kind,
              startLine: spec.startPosition.row + 1,
              endLine: spec.endPosition.row + 1,
            });
          }
        }
        return;
      }

      // TS/JS export wrapper
      case "export_statement": {
        const decl = node.childForFieldName("declaration");
        if (decl) walk(decl);
        return;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        for (const declarator of node.namedChildren) {
          if (declarator.type === "variable_declarator") {
            const val = declarator.childForFieldName("value");
            if (val && (val.type === "arrow_function" || val.type === "function")) {
              const name = declarator.childForFieldName("name")?.text ?? "(anonymous)";
              entries.push({ name, kind: "function", startLine, endLine });
            }
          }
        }
        return;
      }

      // Rust
      case "function_item": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        entries.push({ name, kind: "function", startLine, endLine });
        return;
      }
      case "struct_item": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        entries.push({ name, kind: "struct", startLine, endLine });
        return;
      }
      case "enum_item": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        entries.push({ name, kind: "enum", startLine, endLine });
        return;
      }
      case "trait_item": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        entries.push({ name, kind: "trait", startLine, endLine });
        return;
      }
      case "impl_item": {
        const typeName = node.childForFieldName("type")?.text ?? "(anonymous)";
        entries.push({ name: typeName, kind: "impl", startLine, endLine });
        const body = node.childForFieldName("body");
        if (body) {
          for (const item of body.namedChildren) {
            if (item.type === "function_item") walk(item);
          }
        }
        return;
      }

      // C/C++ specifiers
      case "struct_specifier":
      case "class_specifier": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          entries.push({
            name,
            kind: node.type === "struct_specifier" ? "struct" : "class",
            startLine,
            endLine,
          });
        }
        return;
      }
      case "namespace_definition": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        entries.push({ name, kind: "namespace", startLine, endLine });
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) walk(child);
        }
        return;
      }
    }

    // Recurse into children for nodes we didn't handle
    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  // Only walk top-level children, let the walk function recurse where needed
  for (const child of root.namedChildren) {
    walk(child);
  }

  return entries;
}

/** Extensions treated as prose/documentation — get a structured extractor instead of firstNLines. */
const PROSE_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

/**
 * Extract a structured skeleton from a markdown/prose file.
 * Pulls headings, list items, and paragraph openings to create a meaningful
 * representation that embeds well for conceptual queries.
 */
function skeletonProse(content: string): { text: string; entries: SkeletonEntry[] } {
  const lines = content.split("\n");
  const parts: string[] = [];
  const entries: SkeletonEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Headings: # Title, ## Section, etc.
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      parts.push(line);
      entries.push({
        name: headingMatch[2].trim(),
        kind: `h${headingMatch[1].length}`,
        startLine: i + 1,
        endLine: i + 1,
      });
      continue;
    }

    // List items (- item, * item, 1. item)
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      parts.push(line);
      continue;
    }

    // Non-empty lines that start a paragraph (first non-blank after blank)
    if (trimmed.length > 0 && (i === 0 || lines[i - 1].trim() === "")) {
      parts.push(line);
      continue;
    }

    // Code fence labels
    if (trimmed.startsWith("```")) {
      parts.push(line);
      continue;
    }
  }

  // If the structured extraction is too sparse, use more of the original content
  const text = parts.length >= 5 ? parts.join("\n") : content;
  return { text, entries };
}

export async function extractSkeletonWithEntries(
  filePath: string,
  content: string,
  fallbackLines = 50,
): Promise<SkeletonResult> {
  const ext = path.extname(filePath).toLowerCase();
  const lang = EXT_TO_LANG[ext];
  const filename = path.basename(filePath);

  // Prose/documentation files get a structured extractor
  if (!lang && PROSE_EXTENSIONS.has(ext)) {
    const { text, entries } = skeletonProse(content);
    return { text, entries };
  }

  if (!lang) {
    return { text: firstNLines(content, fallbackLines), entries: [] };
  }

  try {
    await initParser();
  } catch {
    return { text: firstNLines(content, fallbackLines), entries: [] };
  }

  let language: Language;
  try {
    language = await loadLanguage(lang);
  } catch {
    return { text: firstNLines(content, fallbackLines), entries: [] };
  }

  let tree: ReturnType<Parser["parse"]>;
  try {
    const parser = new Parser();
    parser.setLanguage(language);
    tree = parser.parse(content);
  } catch {
    return { text: firstNLines(content, fallbackLines), entries: [] };
  }

  if (!tree) return { text: firstNLines(content, fallbackLines), entries: [] };

  try {
    const root = tree.rootNode;
    const entries = collectEntries(root);

    let text: string;
    switch (lang) {
      case "typescript":
      case "tsx":
      case "javascript":
        text = skeletonTypeScript(filename, root, lang);
        break;
      case "python":
        text = skeletonPython(filename, root);
        break;
      case "rust":
        text = skeletonRust(filename, root);
        break;
      case "go":
        text = skeletonGo(filename, root);
        break;
      case "java":
        text = skeletonJava(filename, root);
        break;
      case "c":
      case "cpp":
        text = skeletonC(filename, root, lang);
        break;
      case "c_sharp":
        text = skeletonCSharp(filename, root);
        break;
      default:
        text = firstNLines(content, fallbackLines);
    }

    return { text, entries };
  } catch {
    return { text: firstNLines(content, fallbackLines), entries: [] };
  } finally {
    tree.delete();
  }
}
