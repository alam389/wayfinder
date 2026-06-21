/**
 * Bounded name-based call-graph tracer for Java (SPEC §"Bounded call-graph tracer").
 *
 * Rooted at a handler method, DFS over its **body only** to `maxDepth` (default 3).
 * Resolution is syntactic (tree-sitter), mirroring the Python tracer:
 *   - a `method_invocation` whose name resolves uniquely in the project's
 *     `method_declaration` symbol table → `call`/`high`, and we recurse;
 *   - a method on a signature-typed receiver (a field/var whose declared type we
 *     know) that resolves only ambiguously → `call`/`medium`;
 *   - a name collision across files → `call`/`low` + warning, not recursed;
 *   - DB/ORM touches (repository `.save/.findById/...`, `EntityManager.persist/...`)
 *     → `db`/`medium` with entity + direction (save/persist/merge/delete=write,
 *     find/get/query=read);
 *   - everything unresolved/dynamic stays `opaque`/`low` with the call text.
 *
 * Tiers are never upgraded and targets never invented. A `visited` set bounds
 * recursion.
 */
import type { SyntaxNode } from "web-tree-sitter";
import type { Entity, Step } from "../../schema.js";
import { descendantsOfType, fieldChild, nodeLine } from "./java-helpers.js";

const DB_READ = new Set([
  "find",
  "findById",
  "findAll",
  "findOne",
  "findBy",
  "get",
  "getById",
  "getOne",
  "getReferenceById",
  "query",
  "createQuery",
  "exists",
  "existsById",
  "count",
]);
const DB_WRITE = new Set([
  "save",
  "saveAll",
  "saveAndFlush",
  "persist",
  "merge",
  "remove",
  "delete",
  "deleteById",
  "deleteAll",
  "flush",
  "update",
  "insert",
]);
/** Receiver names/types that look like a JPA repository or entity manager. */
const DB_RECEIVERS = /(repository|repo|dao|entitymanager|em)$/i;

/** A `method_declaration` discovered in a file, keyed by name. */
export interface JavaMethodDef {
  name: string;
  node: SyntaxNode;
  /** Body block of the method. */
  body: SyntaxNode;
  /** Relative file path the method lives in. */
  file: string;
}

/** Per-file symbol tables: file → (method name → def). */
export type JavaSymbolTables = Map<string, Map<string, JavaMethodDef>>;

/**
 * Receiver name → simple type name, gathered from the controller's fields and
 * the handler's locals/params, so a `medium` typed-receiver resolution is possible
 * when name resolution alone is ambiguous.
 */
export type JavaReceiverTypes = Map<string, string>;

export interface JavaTraceInput {
  /** Body block of the handler being traced. */
  body: SyntaxNode;
  /** Relative file path the handler lives in. */
  file: string;
  maxDepth: number;
  /** method lookup, scoped per file (the current file is consulted first). */
  symbols: JavaSymbolTables;
  /** receiver var/field → declared type name (for medium-confidence resolution). */
  receiverTypes: JavaReceiverTypes;
}

export interface JavaTraceResult {
  steps: Step[];
  entities: Entity[];
  warnings: string[];
}

export function traceJavaHandler(input: JavaTraceInput): JavaTraceResult {
  const steps: Step[] = [];
  const warnings: string[] = [];
  const entityByKey = new Map<string, Entity>();
  const visited = new Set<SyntaxNode>();

  const addStep = (s: Omit<Step, "order">): void => {
    steps.push({ order: steps.length + 1, ...s });
  };
  const addEntity = (name: string, direction: Entity["direction"]): void => {
    const key = `${name}|${direction}`;
    if (!entityByKey.has(key)) {
      entityByKey.set(key, { name, kind: "orm", direction, confidence: "medium" });
    }
  };

  /** All `method_invocation` nodes inside a block, in source order. */
  function callsIn(block: SyntaxNode): SyntaxNode[] {
    return descendantsOfType(block, "method_invocation").sort(
      (a, b) => a.startIndex - b.startIndex,
    );
  }

  /**
   * Resolve a method name against the symbol tables. A unique match (current file
   * first) is `high`; >1 match across files is a collision (`low`).
   */
  function resolveMethod(
    name: string,
    file: string,
  ): { def: JavaMethodDef; collision: boolean } | null {
    const local = input.symbols.get(file)?.get(name);
    if (local) return { def: local, collision: false };
    const matches: JavaMethodDef[] = [];
    for (const [, table] of input.symbols) {
      const d = table.get(name);
      if (d) matches.push(d);
    }
    if (matches.length === 0) return null;
    return { def: matches[0], collision: matches.length > 1 };
  }

  function classify(call: SyntaxNode, file: string, depth: number): void {
    const name = fieldChild(call, "name")?.text ?? "";
    if (!name) return;
    const object = fieldChild(call, "object");
    const recvText = object?.text ?? "";
    const rootName = recvText.split(".").pop() ?? recvText;

    // DB/ORM touch on a repository/entity-manager-shaped receiver.
    const isDbRead = DB_READ.has(name);
    const isDbWrite = DB_WRITE.has(name);
    if ((isDbRead || isDbWrite) && looksLikeRepo(recvText, rootName, input.receiverTypes)) {
      const direction = isDbWrite ? "write" : "read";
      const entity =
        entityFromArgs(call) ?? entityFromReceiverType(rootName, input.receiverTypes);
      addStep({
        depth,
        kind: "db",
        target: `${recvText ? `${recvText}.` : ""}${name}`,
        confidence: "medium",
        file,
        line: nodeLine(call),
        detail: entity ? `${direction} ${entity}` : direction,
      });
      if (entity) addEntity(entity, direction);
      return;
    }

    // A call on a receiver whose type we know → resolve the method by name, but
    // only as `medium` (we matched on a typed receiver, not a unique global name).
    if (recvText) {
      const resolved = resolveMethod(name, file);
      if (resolved && !resolved.collision) {
        const typed = input.receiverTypes.has(rootName);
        const def = resolved.def;
        addStep({
          depth,
          kind: "call",
          target: `${recvText}.${name}`,
          confidence: typed ? "medium" : "high",
          file: def.file,
          line: nodeLine(def.node),
          detail: typed ? `via ${input.receiverTypes.get(rootName)}` : null,
        });
        if (depth < input.maxDepth && !visited.has(def.body)) {
          visited.add(def.body);
          for (const c of callsIn(def.body)) classify(c, def.file, depth + 1);
        }
        return;
      }
      if (resolved?.collision) {
        warnings.push(`ambiguous call target "${name}" (defined in multiple files)`);
        addStep({
          depth,
          kind: "call",
          target: `${recvText}.${name}`,
          confidence: "low",
          file,
          line: nodeLine(call),
          detail: "name collision — not recursed",
        });
        return;
      }
      // Method on a receiver we can't resolve — opaque, never guessed.
      addStep({
        depth,
        kind: "opaque",
        target: truncate(`${recvText}.${name}`),
        confidence: "low",
        file,
        line: nodeLine(call),
        detail: "unresolved (method / dynamic dispatch)",
      });
      return;
    }

    // Bare call `name(...)` — resolve against the project symbol tables.
    const resolved = resolveMethod(name, file);
    if (resolved) {
      if (resolved.collision) {
        warnings.push(`ambiguous call target "${name}" (defined in multiple files)`);
        addStep({
          depth,
          kind: "call",
          target: name,
          confidence: "low",
          file,
          line: nodeLine(call),
          detail: "name collision — not recursed",
        });
        return;
      }
      const def = resolved.def;
      addStep({
        depth,
        kind: "call",
        target: name,
        confidence: "high",
        file: def.file,
        line: nodeLine(def.node),
        detail: null,
      });
      if (depth < input.maxDepth && !visited.has(def.body)) {
        visited.add(def.body);
        for (const c of callsIn(def.body)) classify(c, def.file, depth + 1);
      }
      return;
    }

    // Unresolved bare call (constructor, external, dynamic) — opaque.
    addStep({
      depth,
      kind: "opaque",
      target: truncate(name),
      confidence: "low",
      file,
      line: nodeLine(call),
      detail: "unresolved (external or dynamic)",
    });
  }

  for (const c of callsIn(input.body)) classify(c, input.file, 1);

  return { steps, entities: [...entityByKey.values()], warnings };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function looksLikeRepo(
  recvText: string,
  rootName: string,
  receiverTypes: JavaReceiverTypes,
): boolean {
  if (DB_RECEIVERS.test(rootName)) return true;
  const type = receiverTypes.get(rootName);
  return type ? DB_RECEIVERS.test(type) || /JpaRepository|CrudRepository/.test(type) : false;
}

/** First call argument that looks like a constructed/named model → its name. */
function entityFromArgs(call: SyntaxNode): string | undefined {
  const argList = fieldChild(call, "arguments");
  if (!argList) return undefined;
  for (const arg of argList.namedChildren) {
    if (arg.type === "object_creation_expression") {
      const t = fieldChild(arg, "type")?.text;
      if (t && /^[A-Z]/.test(t)) return t;
    }
    if (arg.type === "identifier" && /^[A-Z]/.test(arg.text)) return arg.text;
  }
  return undefined;
}

/** `userRepository` typed `UserRepository` → entity `User` (strip Repository). */
function entityFromReceiverType(
  rootName: string,
  receiverTypes: JavaReceiverTypes,
): string | undefined {
  const type = receiverTypes.get(rootName);
  if (!type) return undefined;
  const m = type.match(/^([A-Z]\w*?)(Repository|Repo|Dao)$/);
  return m ? m[1] : undefined;
}

function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
