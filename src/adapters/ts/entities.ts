/**
 * Entity detection for TS/JS (SPEC §"Entity detection").
 *
 * Declared shapes: `interface` / `type` / `class` → `interface`; a class carrying
 * a TypeORM `@Entity` decorator → `orm`. This module only *classifies a name*; the
 * adapter decides direction (`in`/`out`/`read`/`write`) from where the type appears
 * (request body, response, or a DB read/write hop).
 */
import { Project } from "ts-morph";
import type { Entity } from "../../schema.js";

/** Names of classes decorated with TypeORM's `@Entity` (orm-backed). */
export function collectOrmEntityNames(project: Project): Set<string> {
  const names = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    for (const cls of sf.getClasses()) {
      const decorated = cls.getDecorators().some((d) => d.getName() === "Entity");
      const name = cls.getName();
      if (decorated && name) names.add(name);
    }
  }
  return names;
}

/**
 * Classify a referenced type name against what's declared in the project.
 * `orm` when it's a TypeORM entity class, `interface` for any other declared
 * interface/type-alias/class shape, else `unknown` (resolvable name but no
 * project declaration — e.g. a library type).
 */
export function classifyTypeName(
  project: Project,
  name: string,
  ormNames: Set<string>,
): Entity["kind"] {
  if (ormNames.has(name)) return "orm";
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    if (sf.getInterface(name) || sf.getTypeAlias(name) || sf.getClass(name)) {
      return "interface";
    }
  }
  return "unknown";
}
