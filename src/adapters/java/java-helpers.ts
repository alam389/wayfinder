/**
 * Small tree-sitter `SyntaxNode` helpers shared by the Java adapter + tracer.
 *
 * Mirrors `python/ts-helpers.ts`: web-tree-sitter rows are 0-based, we expose
 * 1-based lines to match the schema. These add a few Java-specific readers for
 * annotations (name + argument lists) on top of the generic node helpers.
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

// ---------------------------------------------------------------------------
// Java annotations
// ---------------------------------------------------------------------------

/** Both annotation node types tree-sitter-java emits. */
export function isAnnotation(node: SyntaxNode): boolean {
  return node.type === "annotation" || node.type === "marker_annotation";
}

/** The simple name of an annotation: `@GetMapping(...)` → `GetMapping`. */
export function annotationName(node: SyntaxNode): string | null {
  if (!isAnnotation(node)) return null;
  return fieldChild(node, "name")?.text ?? null;
}

/**
 * Annotations attached to a declaration. tree-sitter-java places them in a
 * `modifiers` child (for classes/methods/params) made of `marker_annotation`
 * and `annotation` nodes; some grammars also attach them directly.
 */
export function annotationsOf(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const modifiers = node.children.find((c) => c?.type === "modifiers");
  const scope = modifiers ?? node;
  for (const child of scope.children) {
    if (child && isAnnotation(child)) out.push(child);
  }
  return out;
}

/** Find an annotation by simple name on a declaration, or null. */
export function findAnnotation(node: SyntaxNode, name: string): SyntaxNode | null {
  return annotationsOf(node).find((a) => annotationName(a) === name) ?? null;
}

/** Whether a declaration carries an annotation with one of the given names. */
export function hasAnyAnnotation(node: SyntaxNode, names: Set<string>): boolean {
  return annotationsOf(node).some((a) => {
    const n = annotationName(a);
    return n !== null && names.has(n);
  });
}

/** Strip surrounding quotes from a tree-sitter `string_literal` node. */
export function stringLiteralValue(node: SyntaxNode): string {
  // tree-sitter-java exposes string_fragment children for inner content.
  const fragment = node.namedChildren.find((c) => c.type === "string_fragment");
  if (fragment) return fragment.text;
  return node.text.replace(/^"/, "").replace(/"$/, "");
}

/**
 * Read an annotation argument. Handles three forms:
 *   - single string value:        `@GetMapping("/x")`            (key omitted)
 *   - named string value:         `@RequestMapping(path = "/x")`
 *   - named identifier/enum value: `@RequestMapping(method = RequestMethod.GET)`
 *
 * `key` "value" also matches the single, unnamed string form.
 */
export function annotationArg(ann: SyntaxNode, key: string): string | null {
  const list = ann.childForFieldName("arguments");
  if (!list) return null;

  for (const child of list.namedChildren) {
    if (child.type === "element_value_pair") {
      const k = child.childForFieldName("key")?.text;
      const v = child.childForFieldName("value");
      if (k === key && v) return readElementValue(v);
    }
  }

  // unnamed single value: `@GetMapping("/x")` matches key "value" or "path".
  if (key === "value" || key === "path") {
    for (const child of list.namedChildren) {
      if (child.type === "string_literal") return stringLiteralValue(child);
    }
  }
  return null;
}

/** Value of an annotation element: string → content, identifier/enum → text. */
function readElementValue(value: SyntaxNode): string | null {
  if (value.type === "string_literal") return stringLiteralValue(value);
  // RequestMethod.GET (field_access) / GET (identifier) / "x" anything else
  return value.text;
}
