import path from "path";
import { Parser, Language, type Node } from "web-tree-sitter";

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
        if (lines.length > 0) return lines[0].replace(/^\/\*\*\s*/, "").replace(/\*\/$/, "").trim();
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

  for (const node of root.namedChildren) {
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
      case "export_statement": {
        const decl = node.childForFieldName("declaration");
        if (!decl) break;
        if (decl.type === "class_declaration" || decl.type === "abstract_class_declaration") {
          lines.push(...extractTsClass(decl));
          lines.push("");
        } else if (decl.type === "function_declaration") {
          const doc = extractJsDocComment(node);
          lines.push(extractTsFunction(decl));
          if (doc) lines.push(`  """${doc}"""`);
          lines.push("");
        } else if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
          // export const foo = () => ...
          for (const declarator of childrenOfType(decl, "variable_declarator")) {
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
        }
        break;
      }
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

function extractPyClass(node: Node): string[] {
  const lines: string[] = [];
  const name = childText(node, "name");
  lines.push(`class ${name}`);

  const doc = extractPyDocstring(node);
  if (doc) lines.push(`  """${doc}"""`);

  const body = node.childForFieldName("body");
  if (!body) return lines;

  for (const child of body.namedChildren) {
    if (child.type === "function_definition") {
      const mName = childText(child, "name");
      const params = child.childForFieldName("parameters");
      const paramStr = extractPyParams(params);
      const retStr = extractPyReturnAnnotation(child);
      const vis = mName.startsWith("_") && !mName.startsWith("__") ? "-" : "+";
      const mDoc = extractPyDocstring(child);
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

  for (const node of root.namedChildren) {
    if (node.type === "class_definition") {
      lines.push(...extractPyClass(node));
      lines.push("");
    } else if (node.type === "function_definition") {
      const name = childText(node, "name");
      const params = node.childForFieldName("parameters");
      const paramStr = extractPyParams(params);
      const retStr = extractPyReturnAnnotation(node);
      lines.push(`function ${name}(${paramStr})${retStr}`);
      const doc = extractPyDocstring(node);
      if (doc) lines.push(`  """${doc}"""`);
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Rust extractor
// ---------------------------------------------------------------------------

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
        lines.push(`struct ${name}`);
        lines.push("");
        break;
      }
      case "enum_item": {
        const name = childText(node, "name");
        const body = node.childForFieldName("body");
        const variants = body ? childrenOfType(body, "enum_variant").map((v) => childText(v, "name")) : [];
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
        const header = trait ? `impl ${trait.text} for ${type?.text ?? ""}` : `impl ${type?.text ?? ""}`;
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
        if (lines.length > 0) return lines[0].replace(/^\/\*\*\s*/, "").replace(/\*\/$/, "").trim();
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
      const params = member.childForFieldName("parameters") ?? member.childForFieldName("formal_parameters");
      const paramStr = extractJavaParams(params ?? null);
      const retType = member.childForFieldName("type");
      const retStr = retType ? ` -> ${retType.text}` : "";
      // Check for private modifier
      const mods = childrenOfType(member, "modifiers");
      const modText = mods.map((m) => m.text).join(" ");
      const vis = modText.includes("private") ? "-" : "+";
      const doc = extractJavaDoc(member);
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
      const name = node.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier");
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
        for (const ns_child of child.namedChildren) {
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
      const name = childText(node, "name");
      const keyword = node.type === "interface_declaration" ? "interface" : node.type === "struct_declaration" ? "struct" : "class";
      lines.push(`${keyword} ${name}`);
      const body = node.childForFieldName("declaration_list");
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
            lines.push(`  ${vis} ${mName}(${paramStr})${retStr}`);
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
  const ext = path.extname(filePath).toLowerCase();
  const lang = EXT_TO_LANG[ext];
  const filename = path.basename(filePath);

  if (!lang) {
    return firstNLines(content, fallbackLines);
  }

  // Ensure parser is initialised
  try {
    await initParser();
  } catch {
    return firstNLines(content, fallbackLines);
  }

  let language: Language;
  try {
    language = await loadLanguage(lang);
  } catch {
    return firstNLines(content, fallbackLines);
  }

  let tree: ReturnType<Parser["parse"]>;
  try {
    const parser = new Parser();
    parser.setLanguage(language);
    tree = parser.parse(content);
  } catch {
    return firstNLines(content, fallbackLines);
  }

  if (!tree) return firstNLines(content, fallbackLines);

  try {
    const root = tree.rootNode;

    switch (lang) {
      case "typescript":
      case "tsx":
      case "javascript":
        return skeletonTypeScript(filename, root, lang);
      case "python":
        return skeletonPython(filename, root);
      case "rust":
        return skeletonRust(filename, root);
      case "go":
        return skeletonGo(filename, root);
      case "java":
        return skeletonJava(filename, root);
      case "c":
      case "cpp":
        return skeletonC(filename, root, lang);
      case "c_sharp":
        return skeletonCSharp(filename, root);
      default:
        return firstNLines(content, fallbackLines);
    }
  } catch {
    return firstNLines(content, fallbackLines);
  } finally {
    tree.delete();
  }
}
