/**
 * Entity detection for Java (SPEC §"Entity detection").
 *
 * Syntactic, name-based: a class annotated `@Entity` (JPA) is an ORM entity; any
 * other project-declared class is a plain `pojo` (DTO/request/response). This
 * module records what each class *is* (a `kind`); the adapter/tracer decide the
 * `direction` (`in`/`out`/`read`/`write`) from where the type is used.
 */
import type { SyntaxNode } from "web-tree-sitter";
import type { Entity } from "../../schema.js";
import { descendantsOfType, fieldChild, hasAnyAnnotation } from "./java-helpers.js";

const ENTITY_ANNOTATIONS = new Set(["Entity"]);

/**
 * A registry of class name → entity kind, built once per file set by scanning
 * class declarations. A class annotated `@Entity` is `orm`; every other declared
 * class is `pojo`. Cross-file: a name maps to the first kind we resolve for it.
 */
export type JavaEntityTable = Map<string, Entity["kind"]>;

/** Scan one parsed tree's `class_declaration`s into the entity table. */
export function collectJavaClasses(root: SyntaxNode, table: JavaEntityTable): void {
  for (const cls of descendantsOfType(root, "class_declaration")) {
    const name = fieldChild(cls, "name")?.text;
    if (!name || table.has(name)) continue;
    const kind: Entity["kind"] = hasAnyAnnotation(cls, ENTITY_ANNOTATIONS) ? "orm" : "pojo";
    table.set(name, kind);
  }
}

/** Classify a referenced type name against the project's entity table. */
export function classifyJavaType(name: string, table: JavaEntityTable): Entity["kind"] {
  return table.get(name) ?? "unknown";
}
