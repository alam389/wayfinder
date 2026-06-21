/**
 * Bounded name-based call-graph tracer for Python (SPEC §"Bounded call-graph tracer").
 *
 * Rooted at a handler, DFS over its **body only** to `maxDepth` (default 3).
 * Resolution is syntactic (tree-sitter): a plain call whose name resolves in the
 * per-file `def` symbol table is a `high` `call` step and we recurse; a method on
 * a signature-typed receiver is `medium`; DB/ORM touches are `db`/`medium` with
 * entity + direction; `.invoke/.ainvoke/.stream` is a `graph` step that sets
 * `triggers_graph`; everything unresolved stays `opaque`/`low` with the call text
 * recorded. Tiers are never upgraded and targets never invented. A cross-file
 * name collision degrades to `low` with a warning. A `visited` set bounds cycles.
 */
import type { SyntaxNode } from "web-tree-sitter";
import type { Entity, Step } from "../../schema.js";
import { fieldChild, namedChildren, nodeLine } from "./ts-helpers.js";

const DB_READ = new Set([
  "query",
  "get",
  "first",
  "all",
  "filter",
  "filter_by",
  "find",
  "find_one",
  "scalar",
  "scalars",
  "execute",
  "select",
]);
const DB_WRITE = new Set([
  "add",
  "add_all",
  "save",
  "commit",
  "delete",
  "merge",
  "insert",
  "update",
  "bulk_save_objects",
  "flush",
]);
const GRAPH_INVOKE = new Set(["invoke", "ainvoke", "stream", "astream"]);
const DB_RECEIVERS = /(^|_)(db|session|repo|repository|store)$/i;

/** A `def` declaration discovered in a file, keyed by name. */
export interface PyFunctionDef {
  name: string;
  node: SyntaxNode;
  /** Body block of the function. */
  body: SyntaxNode;
  /** Relative file path the def lives in. */
  file: string;
}

/** Per-file symbol tables: file → (name → def). */
export type PySymbolTables = Map<string, Map<string, PyFunctionDef>>;

export interface PyTraceInput {
  /** Body block of the handler being traced. */
  body: SyntaxNode;
  /** Relative file path the handler lives in. */
  file: string;
  maxDepth: number;
  /** def lookup, scoped per file (the current file is consulted first). */
  symbols: PySymbolTables;
  /** Receivers to skip (rarely needed for FastAPI — kept for parity with TS). */
  skipReceivers?: Set<string>;
}

export interface PyTraceResult {
  steps: Step[];
  entities: Entity[];
  triggersGraph: string | null;
  warnings: string[];
}

export function tracePyHandler(input: PyTraceInput): PyTraceResult {
  const steps: Step[] = [];
  const warnings: string[] = [];
  const entityByKey = new Map<string, Entity>();
  const visited = new Set<SyntaxNode>();
  let triggersGraph: string | null = null;
  const skip = input.skipReceivers ?? new Set<string>();

  const addStep = (s: Omit<Step, "order">): void => {
    steps.push({ order: steps.length + 1, ...s });
  };
  const addEntity = (name: string, direction: Entity["direction"]): void => {
    const key = `${name}|${direction}`;
    if (!entityByKey.has(key)) {
      entityByKey.set(key, { name, kind: "orm", direction, confidence: "medium" });
    }
  };

  /** All `call` nodes inside a block, in source order. */
  function callsIn(block: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    const stack: SyntaxNode[] = [block];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      if (n.type === "call") out.push(n);
      // walk into all named children to reach nested calls/expressions
      for (let i = n.namedChildren.length - 1; i >= 0; i--) {
        stack.push(n.namedChildren[i]);
      }
    }
    return out.sort((a, b) => a.startIndex - b.startIndex);
  }

  function resolveDef(name: string, file: string): { def: PyFunctionDef; collision: boolean } | null {
    const local = input.symbols.get(file)?.get(name);
    if (local) return { def: local, collision: false };
    // Cross-file: search every file's table; >1 match is a collision.
    const matches: PyFunctionDef[] = [];
    for (const [, table] of input.symbols) {
      const d = table.get(name);
      if (d) matches.push(d);
    }
    if (matches.length === 0) return null;
    return { def: matches[0], collision: matches.length > 1 };
  }

  function classify(call: SyntaxNode, file: string, depth: number): void {
    const fn = fieldChild(call, "function");
    if (!fn) return;

    if (fn.type === "attribute") {
      const object = fieldChild(fn, "object");
      const attr = fieldChild(fn, "attribute");
      const method = attr?.text ?? "";
      const recvText = object?.text ?? "";
      const rootName = recvText.split(".")[0];
      if (rootName && skip.has(rootName)) return;

      if (GRAPH_INVOKE.has(method)) {
        triggersGraph ??= recvText;
        addStep({
          depth,
          kind: "graph",
          target: `${recvText}.${method}`,
          confidence: "medium",
          file,
          line: nodeLine(call),
          detail: "agent-graph invocation",
        });
        return;
      }

      const isDbRead = DB_READ.has(method);
      const isDbWrite = DB_WRITE.has(method);
      if ((isDbRead || isDbWrite) && looksLikeRepo(recvText)) {
        const direction = isDbWrite ? "write" : "read";
        const entity = entityFromArgs(call) ?? entityFromReceiver(recvText);
        addStep({
          depth,
          kind: "db",
          target: `${recvText}.${method}`,
          confidence: "medium",
          file,
          line: nodeLine(call),
          detail: entity ? `${direction} ${entity}` : direction,
        });
        if (entity) addEntity(entity, direction);
        return;
      }

      // Method call we can't resolve to a project def — opaque, never guessed.
      addStep({
        depth,
        kind: "opaque",
        target: truncate(`${recvText}.${method}`),
        confidence: "low",
        file,
        line: nodeLine(call),
        detail: "unresolved (method / dynamic dispatch)",
      });
      return;
    }

    if (fn.type === "identifier") {
      const name = fn.text;
      if (skip.has(name)) return;
      const resolved = resolveDef(name, file);
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
    }

    // Unresolved bare call (constructor, external function, dynamic) — opaque.
    addStep({
      depth,
      kind: "opaque",
      target: truncate(fn.text),
      confidence: "low",
      file,
      line: nodeLine(call),
      detail: "unresolved (external or dynamic)",
    });
  }

  for (const c of callsIn(input.body)) classify(c, input.file, 1);

  return {
    steps,
    entities: [...entityByKey.values()],
    triggersGraph,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function looksLikeRepo(recvText: string): boolean {
  const root = recvText.split(".")[0];
  return DB_RECEIVERS.test(root) || DB_RECEIVERS.test(recvText.split(".").pop() ?? "");
}

/** First call argument that looks like a constructed model: `Model(...)` → `Model`. */
function entityFromArgs(call: SyntaxNode): string | undefined {
  const argList = fieldChild(call, "arguments");
  if (!argList) return undefined;
  for (const arg of namedChildren(argList)) {
    if (arg.type === "call") {
      const fn = fieldChild(arg, "function");
      if (fn?.type === "identifier" && /^[A-Z]/.test(fn.text)) return fn.text;
    }
    if (arg.type === "identifier" && /^[A-Z]/.test(arg.text)) return arg.text;
  }
  return undefined;
}

/** `db.query(User)` style — a capitalized receiver segment is the entity. */
function entityFromReceiver(recvText: string): string | undefined {
  for (const seg of recvText.split(".")) {
    if (/^[A-Z]\w*$/.test(seg)) return seg;
  }
  return undefined;
}

function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
