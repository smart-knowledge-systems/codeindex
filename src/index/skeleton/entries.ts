import type { Node } from "web-tree-sitter";
import type { SkeletonEntry } from "../../search/types";
import { firstChildOfType } from "../skeleton-utils";
import { isKotlinInterface } from "./lang-kotlin";
import { elixirFuncName } from "./lang-elixir";

// ---------------------------------------------------------------------------
// collectEntries + walk — extract structured entries from AST
// ---------------------------------------------------------------------------

/** Extract entries (name, kind, startLine, endLine) from a tree-sitter AST root. */
export function collectEntries(root: Node): SkeletonEntry[] {
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
      } else if (member.type === "function_declaration") {
        // Kotlin: member functions inside class_body
        const mName =
          member.childForFieldName("name")?.text ??
          firstChildOfType(member, "simple_identifier")?.text;
        if (mName) {
          entries.push({
            name: mName,
            kind: "method",
            startLine: member.startPosition.row + 1,
            endLine: member.endPosition.row + 1,
          });
        }
      } else if (member.type === "companion_object") {
        // Kotlin companion object — recurse into it
        walk(member);
      }
    }
  }

  function walk(node: Node): void {
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    switch (node.type) {
      // Functions: TS/JS/Go/Kotlin function_declaration, TS function
      case "function_declaration":
      case "function": {
        const name =
          node.childForFieldName("name")?.text ??
          firstChildOfType(node, "simple_identifier")?.text ??
          "(anonymous)";
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

      // Classes: TS/JS/Java/C#/Kotlin
      case "class_declaration":
      case "abstract_class_declaration":
      case "interface_declaration":
      case "protocol_declaration":
      case "enum_declaration":
      case "struct_declaration": {
        const name =
          node.childForFieldName("name")?.text ??
          firstChildOfType(node, "type_identifier")?.text ??
          "(anonymous)";
        // Detect actual kind from keyword child (Kotlin interface, Swift struct/enum)
        let kind = node.type.replace("_declaration", "").replace("abstract_", "");
        if (kind === "class") {
          const firstChild = node.child(0);
          const kw = firstChild?.type;
          if (kw === "interface" || isKotlinInterface(node)) kind = "interface";
          else if (kw === "struct") kind = "struct";
          else if (kw === "enum") kind = "enum";
        }
        entries.push({ name, kind, startLine, endLine });
        const body =
          node.childForFieldName("body") ??
          node.childForFieldName("declaration_list") ??
          firstChildOfType(node, "class_body", "enum_class_body", "protocol_body");
        if (body) collectMethodsFromBody(body);
        return;
      }

      // Kotlin object declarations
      case "object_declaration": {
        const name = firstChildOfType(node, "type_identifier")?.text ?? "(anonymous)";
        entries.push({ name, kind: "class", startLine, endLine });
        const body = firstChildOfType(node, "class_body");
        if (body) collectMethodsFromBody(body);
        return;
      }

      // Kotlin companion object
      case "companion_object": {
        entries.push({ name: "Companion", kind: "class", startLine, endLine });
        const body = firstChildOfType(node, "class_body");
        if (body) collectMethodsFromBody(body);
        return;
      }

      // TS type alias / Swift typealias
      case "type_alias_declaration":
      case "typealias_declaration": {
        const name =
          node.childForFieldName("name")?.text ??
          firstChildOfType(node, "type_identifier")?.text ??
          "(anonymous)";
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
            walk(child);
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
        // TS/JS: arrow functions / function expressions
        for (const declarator of node.namedChildren) {
          if (declarator.type === "variable_declarator") {
            const val = declarator.childForFieldName("value");
            if (val && (val.type === "arrow_function" || val.type === "function")) {
              const name = declarator.childForFieldName("name")?.text ?? "(anonymous)";
              entries.push({ name, kind: "function", startLine, endLine });
            }
          }
        }
        // Zig: variable_declaration wrapping struct/enum/union/error_set
        const zigName = firstChildOfType(node, "identifier")?.text;
        if (zigName) {
          const zigValue = node.namedChildren.find(
            (c) =>
              c.type === "struct_declaration" ||
              c.type === "enum_declaration" ||
              c.type === "union_declaration" ||
              c.type === "error_set_declaration",
          );
          if (zigValue) {
            const zigKindMap: Record<string, string> = {
              struct_declaration: "struct",
              enum_declaration: "enum",
              union_declaration: "union",
              error_set_declaration: "enum",
            };
            entries.push({
              name: zigName,
              kind: zigKindMap[zigValue.type] ?? "struct",
              startLine,
              endLine,
            });
            for (const child of zigValue.namedChildren) {
              if (child.type === "function_declaration") {
                const mName = child.childForFieldName("name")?.text ?? "(anonymous)";
                entries.push({
                  name: mName,
                  kind: "method",
                  startLine: child.startPosition.row + 1,
                  endLine: child.endPosition.row + 1,
                });
              }
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
      case "template_declaration": {
        // Walk into the inner declaration
        for (const child of node.namedChildren) {
          if (child !== node.childForFieldName("parameters")) walk(child);
        }
        return;
      }
      case "type_definition": {
        // C/C++: has "declarator" field
        const declarator = node.childForFieldName("declarator");
        if (declarator) {
          entries.push({ name: declarator.text, kind: "typedef", startLine, endLine });
          return;
        }
        // Scala: has "name" field
        const typeName =
          node.childForFieldName("name")?.text ?? firstChildOfType(node, "type_identifier")?.text;
        if (typeName) {
          entries.push({ name: typeName, kind: "type", startLine, endLine });
        }
        return;
      }

      // Ruby module/class/method
      case "module":
      case "class": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        entries.push({ name, kind: "class", startLine, endLine });
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) walk(child);
        }
        return;
      }
      case "method":
      case "singleton_method": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        entries.push({ name, kind: "method", startLine, endLine });
        return;
      }

      // Ruby attr_accessor, attr_reader, attr_writer + Elixir call dispatch
      case "call": {
        // Ruby: call nodes have a `method` field
        const methodNode = node.childForFieldName("method");
        if (
          methodNode &&
          (methodNode.text === "attr_accessor" ||
            methodNode.text === "attr_reader" ||
            methodNode.text === "attr_writer")
        ) {
          const args = node.childForFieldName("arguments");
          if (args) {
            for (const arg of args.namedChildren) {
              if (arg.type === "simple_symbol" || arg.type === "symbol") {
                const propName = arg.text.replace(/^:/, "");
                entries.push({ name: propName, kind: "property", startLine, endLine });
              }
            }
          }
          return;
        }

        // Elixir: call nodes have identifier as first child
        const elixirId = firstChildOfType(node, "identifier");
        if (elixirId) {
          const callKind = elixirId.text;
          const callArgs = firstChildOfType(node, "arguments");
          const callDoBlock = firstChildOfType(node, "do_block");

          if (callKind === "defmodule") {
            const name = callArgs
              ? (firstChildOfType(callArgs, "alias")?.text ?? "(anonymous)")
              : "(anonymous)";
            entries.push({ name, kind: "class", startLine, endLine });
            if (callDoBlock) {
              for (const child of callDoBlock.namedChildren) walk(child);
            }
            return;
          }
          if (callKind === "def" || callKind === "defp") {
            const name = elixirFuncName(callArgs);
            entries.push({ name, kind: "function", startLine, endLine });
            return;
          }
          if (callKind === "defmacro" || callKind === "defmacrop") {
            const name = elixirFuncName(callArgs);
            entries.push({ name, kind: "function", startLine, endLine });
            return;
          }
          if (callKind === "defprotocol") {
            const name = callArgs
              ? (firstChildOfType(callArgs, "alias")?.text ?? "(anonymous)")
              : "(anonymous)";
            entries.push({ name, kind: "interface", startLine, endLine });
            if (callDoBlock) {
              for (const child of callDoBlock.namedChildren) walk(child);
            }
            return;
          }
          if (callKind === "defimpl") {
            const name = callArgs
              ? (firstChildOfType(callArgs, "alias")?.text ?? "(anonymous)")
              : "(anonymous)";
            entries.push({ name, kind: "impl", startLine, endLine });
            if (callDoBlock) {
              for (const child of callDoBlock.namedChildren) walk(child);
            }
            return;
          }
        }
        return;
      }

      // Lua functions
      case "function_definition_statement":
      case "local_function_definition_statement": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        entries.push({ name, kind: "function", startLine, endLine });
        return;
      }

      // PHP trait
      case "trait_declaration": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        entries.push({ name, kind: "class", startLine, endLine });
        const body = node.childForFieldName("body") ?? firstChildOfType(node, "declaration_list");
        if (body) collectMethodsFromBody(body);
        return;
      }

      // Scala
      case "object_definition": {
        const name =
          node.childForFieldName("name")?.text ??
          firstChildOfType(node, "identifier")?.text ??
          "(anonymous)";
        entries.push({ name, kind: "object", startLine, endLine });
        const body = node.childForFieldName("body") ?? firstChildOfType(node, "template_body");
        if (body) {
          for (const child of body.namedChildren) walk(child);
        }
        return;
      }
      case "trait_definition": {
        const name =
          node.childForFieldName("name")?.text ??
          firstChildOfType(node, "identifier")?.text ??
          "(anonymous)";
        entries.push({ name, kind: "trait", startLine, endLine });
        const body = node.childForFieldName("body") ?? firstChildOfType(node, "template_body");
        if (body) {
          for (const child of body.namedChildren) walk(child);
        }
        return;
      }
      case "val_definition":
      case "var_definition": {
        const name = firstChildOfType(node, "identifier")?.text ?? "(anonymous)";
        entries.push({ name, kind: "property", startLine, endLine });
        return;
      }

      // Zig: test blocks
      case "test_declaration": {
        const strNode = firstChildOfType(node, "string");
        const testName = strNode
          ? (strNode.namedChildren.find((c) => c.type === "string_content")?.text ?? "test")
          : "test";
        entries.push({ name: testName, kind: "function", startLine, endLine });
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
