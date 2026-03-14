import type { Node } from "web-tree-sitter";

/**
 * Shared utility functions for tree-sitter skeleton extractors.
 * Extracted from skeleton.ts to reduce duplication across language handlers.
 */

/** Get text of a named child field. */
export function childText(node: Node, fieldName: string): string {
  return node.childForFieldName(fieldName)?.text ?? "";
}

/** Get the node's text content. */
export function nodeText(node: Node): string {
  return node.text;
}

/** Return the first child whose type matches one of the given types. */
export function firstChildOfType(node: Node, ...types: string[]): Node | null {
  for (const child of node.children) {
    if (types.includes(child.type)) return child;
  }
  return null;
}

/** Collect immediate named children with a given type. */
export function childrenOfType(node: Node, ...types: string[]): Node[] {
  return node.namedChildren.filter((c) => types.includes(c.type));
}

/** Walk all descendants (breadth-first) matching a type set. */
export function descendantsOfType(node: Node, types: string[]): Node[] {
  return node.descendantsOfType(types);
}

/** Extract parameter strings from a parameter list node. Generic helper for many languages. */
export function extractParamList(
  params: Node | null,
  opts: {
    /** Node types that represent a parameter (e.g., "parameter", "formal_parameter"). */
    paramTypes: string[];
    /** Field name for the parameter's type annotation. */
    typeField?: string;
    /** Field name for the parameter's name/identifier. */
    nameField?: string;
    /** Names to skip (e.g., "self", "cls" for Python). */
    skipNames?: string[];
  },
): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const p of params.namedChildren) {
    if (opts.paramTypes.includes(p.type)) {
      const nameNode = opts.nameField ? p.childForFieldName(opts.nameField) : null;
      const typeNode = opts.typeField ? p.childForFieldName(opts.typeField) : null;
      const name = nameNode?.text ?? p.text.split("\n")[0];
      if (opts.skipNames?.includes(name)) continue;
      if (typeNode) {
        parts.push(`${name}: ${typeNode.text}`);
      } else {
        parts.push(name);
      }
    }
  }
  return parts.join(", ");
}
