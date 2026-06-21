/**
 * Entity detection for Python (SPEC §"Entity detection").
 *
 * Syntactic, name-based: a class whose bases include `BaseModel` is Pydantic; a
 * class whose bases include `Base`/`DeclarativeBase` is a SQLAlchemy ORM model.
 * This module records what each class *is* (a `kind`); the adapter/tracer decide
 * the `direction` (`in`/`out`/`read`/`write`) from where the type is used.
 */
import type { Entity } from "../../schema.js";

const PYDANTIC_BASES = new Set(["BaseModel"]);
const ORM_BASES = new Set(["Base", "DeclarativeBase"]);

/**
 * A registry of class name → entity kind, built once per file set by scanning
 * class definitions and their base class lists. Cross-file: a name maps to the
 * first kind we resolve for it (collisions are unlikely for entity classes).
 */
export type PyEntityTable = Map<string, Entity["kind"]>;

/** Record a class's kind given its declared base-class names. */
export function classifyBases(bases: string[]): Entity["kind"] | null {
  for (const b of bases) {
    if (PYDANTIC_BASES.has(b)) return "pydantic";
  }
  for (const b of bases) {
    if (ORM_BASES.has(b)) return "orm";
  }
  return null;
}

/** Classify a referenced type name against the project's entity table. */
export function classifyPyType(name: string, table: PyEntityTable): Entity["kind"] {
  return table.get(name) ?? "unknown";
}
