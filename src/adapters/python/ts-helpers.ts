/**
 * Small tree-sitter `SyntaxNode` helpers shared by the Python adapter + tracer.
 *
 * web-tree-sitter rows are 0-based; we expose 1-based lines to match the schema
 * (and the ts-morph adapters). Thin wrappers keep call sites readable and guard
 * against the nullable `childForFieldName`.
 */
import type { SyntaxNode } from "web-tree-sitter";

/** 1-based start line of a node (tree-sitter rows are 0-based). */
export function nodeLine(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

/** Field child or null (rename for brevity over `childForFieldName`). */
export function fieldChild(node: SyntaxNode, field: string): SyntaxNode | null {
  return node.childForFieldName(field);
}

/** Named children as a plain array. */
export function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren;
}

/** Depth-first descendants of a given type under `root` (inclusive of root). */
export function descendantsOfType(root: SyntaxNode, type: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.type === type) out.push(n);
    for (let i = n.namedChildren.length - 1; i >= 0; i--) stack.push(n.namedChildren[i]);
  }
  return out;
}
