import type { Node } from "web-tree-sitter";
import { firstChildOfType, descendantsOfType } from "../skeleton-utils";

// ---------------------------------------------------------------------------
// Elixir extractor
// ---------------------------------------------------------------------------

export function elixirFuncName(argsNode: Node | null): string {
  if (!argsNode) return "(anonymous)";
  const first = argsNode.namedChildren[0];
  if (!first) return "(anonymous)";

  if (first.type === "call") {
    const id = firstChildOfType(first, "identifier");
    return id?.text ?? "(anonymous)";
  }
  if (first.type === "binary_operator") {
    const inner = firstChildOfType(first, "call");
    if (inner) {
      const id = firstChildOfType(inner, "identifier");
      return id?.text ?? "(anonymous)";
    }
  }
  if (first.type === "identifier") {
    return first.text;
  }
  return "(anonymous)";
}

export function elixirFuncParams(argsNode: Node | null): string {
  if (!argsNode) return "";
  const first = argsNode.namedChildren[0];
  if (!first) return "";

  let callNode: Node | null = null;
  if (first.type === "call") {
    callNode = first;
  } else if (first.type === "binary_operator") {
    callNode = firstChildOfType(first, "call");
  }
  if (!callNode) return "";

  const innerArgs = firstChildOfType(callNode, "arguments");
  if (!innerArgs) return "";
  return innerArgs.namedChildren
    .filter((p) => p.type !== "," && p.type !== "(" && p.type !== ")")
    .map((p) => p.text)
    .join(", ");
}

export function skeletonElixir(filename: string, root: Node): string {
  const lines: string[] = [`# ${filename} [Elixir]`];

  const imports: string[] = [];
  for (const node of descendantsOfType(root, ["call"])) {
    const id = firstChildOfType(node, "identifier");
    if (!id) continue;
    const kind = id.text;
    if (kind === "use" || kind === "import" || kind === "alias" || kind === "require") {
      const args = firstChildOfType(node, "arguments");
      if (args) {
        const alias_ = firstChildOfType(args, "alias");
        if (alias_) imports.push(`${kind} ${alias_.text}`);
      }
    }
  }
  if (imports.length > 0) lines.push(`imports: ${imports.join(", ")}`);
  lines.push("");

  function processCall(node: Node, indent = ""): void {
    const id = firstChildOfType(node, "identifier");
    if (!id) return;
    const kind = id.text;
    const args = firstChildOfType(node, "arguments");
    const doBlock = firstChildOfType(node, "do_block");

    switch (kind) {
      case "defmodule": {
        const name = args
          ? (firstChildOfType(args, "alias")?.text ?? "(anonymous)")
          : "(anonymous)";
        lines.push(`${indent}defmodule ${name}`);
        if (doBlock) {
          for (const child of doBlock.namedChildren) {
            if (child.type === "call") processCall(child, indent + "  ");
          }
        }
        lines.push("");
        break;
      }
      case "def":
      case "defp": {
        const name = elixirFuncName(args);
        const params = elixirFuncParams(args);
        const vis = kind === "defp" ? "defp" : "def";
        lines.push(`${indent}${vis} ${name}(${params})`);
        break;
      }
      case "defmacro":
      case "defmacrop": {
        const name = elixirFuncName(args);
        const params = elixirFuncParams(args);
        lines.push(`${indent}${kind} ${name}(${params})`);
        break;
      }
      case "defstruct": {
        if (args) {
          const list = firstChildOfType(args, "list");
          if (list) {
            const fields = list.namedChildren
              .filter((a) => a.type === "atom")
              .map((a) => a.text.replace(/^:/, ""));
            if (fields.length > 0) {
              lines.push(`${indent}defstruct [${fields.join(", ")}]`);
            }
          }
        }
        break;
      }
      case "defprotocol": {
        const name = args
          ? (firstChildOfType(args, "alias")?.text ?? "(anonymous)")
          : "(anonymous)";
        lines.push(`${indent}defprotocol ${name}`);
        if (doBlock) {
          for (const child of doBlock.namedChildren) {
            if (child.type === "call") processCall(child, indent + "  ");
          }
        }
        lines.push("");
        break;
      }
      case "defimpl": {
        const protoName = args
          ? (firstChildOfType(args, "alias")?.text ?? "(anonymous)")
          : "(anonymous)";
        let forName = "";
        if (args) {
          const kw = firstChildOfType(args, "keywords");
          if (kw) {
            const pair = firstChildOfType(kw, "pair");
            if (pair) {
              const alias_ = firstChildOfType(pair, "alias");
              if (alias_) forName = alias_.text;
            }
          }
        }
        const suffix = forName ? `, for: ${forName}` : "";
        lines.push(`${indent}defimpl ${protoName}${suffix}`);
        if (doBlock) {
          for (const child of doBlock.namedChildren) {
            if (child.type === "call") processCall(child, indent + "  ");
          }
        }
        lines.push("");
        break;
      }
    }
  }

  for (const node of root.namedChildren) {
    if (node.type === "call") processCall(node);
  }

  return lines.join("\n").trimEnd();
}
