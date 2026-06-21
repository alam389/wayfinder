/**
 * Bounded call-graph tracer for TS/JS (SPEC §"Bounded call-graph tracer").
 *
 * Rooted at a handler, DFS over its **body only** (never its signature), to
 * `maxDepth` (default 3). Calls resolved into project source via the type
 * checker are `high`-confidence `call` steps and we recurse; DB/ORM touches are
 * `medium` `db` steps; agent-graph `.invoke/.ainvoke/...` sets `triggers_graph`;
 * everything unresolved (dynamic dispatch, library calls) stays `opaque`/`low`
 * with the call text recorded. Tiers are never upgraded and targets never invented.
 */
import * as path from "node:path";
import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import type { Confidence, Entity, Step } from "../../schema.js";

const DB_READ = new Set([
  "find",
  "findone",
  "findoneby",
  "findby",
  "findmany",
  "findunique",
  "findfirst",
  "get",
  "query",
  "select",
  "count",
  "exists",
]);
const DB_WRITE = new Set([
  "save",
  "insert",
  "update",
  "delete",
  "remove",
  "persist",
  "add",
  "create",
  "upsert",
  "createmany",
  "updatemany",
  "deletemany",
]);
const GRAPH_INVOKE = new Set(["invoke", "ainvoke", "stream", "astream"]);

export interface TraceInput {
  /** The handler function/arrow whose body is traced. */
  bodyNode: Node;
  /** File (relative to root) the handler lives in. */
  file: string;
  root: string;
  maxDepth: number;
  /** Receiver identifiers to treat as framework I/O, not business calls (req/res/next). */
  skipReceivers: Set<string>;
}

export interface TraceResult {
  steps: Step[];
  /** ORM entities touched by DB hops, with their read/write direction. */
  entities: Entity[];
  triggersGraph: string | null;
  warnings: string[];
}

export function traceHandler(input: TraceInput): TraceResult {
  const steps: Step[] = [];
  const warnings: string[] = [];
  const entityByKey = new Map<string, Entity>();
  const visited = new Set<Node>();
  let triggersGraph: string | null = null;

  const rel = (sf: SourceFile): string => path.relative(input.root, sf.getFilePath());

  const addStep = (s: Omit<Step, "order">): void => {
    steps.push({ order: steps.length + 1, ...s });
  };

  const addEntity = (name: string, direction: Entity["direction"]): void => {
    const key = `${name}|${direction}`;
    if (!entityByKey.has(key)) {
      entityByKey.set(key, { name, kind: "orm", direction, confidence: "medium" });
    }
  };

  function traceBody(body: Node, file: string, depth: number): void {
    for (const ce of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      classifyCall(ce, file, depth);
    }
  }

  function classifyCall(ce: Node, file: string, depth: number): void {
    if (!Node.isCallExpression(ce)) return;
    const expr = ce.getExpression();

    // Framework I/O on the handler's req/res/next — surface, not a trace step.
    const rootName = rootIdentifierName(expr);
    if (rootName && input.skipReceivers.has(rootName)) return;

    if (Node.isPropertyAccessExpression(expr)) {
      const method = expr.getName().toLowerCase();
      const receiver = expr.getExpression();

      if (GRAPH_INVOKE.has(method)) {
        triggersGraph ??= receiver.getText();
        addStep({
          depth,
          kind: "graph",
          target: `${receiver.getText()}.${expr.getName()}`,
          confidence: "medium",
          file,
          line: ce.getStartLineNumber(),
          detail: "agent-graph invocation",
        });
        return;
      }

      if ((DB_READ.has(method) || DB_WRITE.has(method)) && looksLikeRepo(receiver)) {
        const direction = DB_WRITE.has(method) ? "write" : "read";
        const entity = entityFromReceiver(receiver) ?? entityFromFirstArg(ce);
        addStep({
          depth,
          kind: "db",
          target: `${receiver.getText()}.${expr.getName()}`,
          confidence: "medium",
          file,
          line: ce.getStartLineNumber(),
          detail: entity ? `${direction} ${entity}` : direction,
        });
        if (entity) addEntity(entity, direction);
        return;
      }
    }

    const resolved = resolveUserCallee(ce);
    if (resolved) {
      if (resolved.defs.length > 1) {
        warnings.push(`ambiguous call target "${resolved.name}" (${resolved.defs.length} defs)`);
        addStep({
          depth,
          kind: "call",
          target: resolved.name,
          confidence: "low",
          file,
          line: ce.getStartLineNumber(),
          detail: "name collision — not recursed",
        });
        return;
      }
      const def = resolved.defs[0];
      const calleeBody = getCallableBody(def);
      const defSf = def.getSourceFile();
      addStep({
        depth,
        kind: "call",
        target: resolved.name,
        confidence: "high",
        file: rel(defSf),
        line: def.getStartLineNumber(),
        detail: null,
      });
      if (depth < input.maxDepth && calleeBody && !visited.has(calleeBody)) {
        visited.add(calleeBody);
        traceBody(calleeBody, rel(defSf), depth + 1);
      }
      return;
    }

    // Unresolved: dynamic dispatch or an external library call. Never guess.
    addStep({
      depth,
      kind: "opaque",
      target: truncate(expr.getText()),
      confidence: "low" as Confidence,
      file,
      line: ce.getStartLineNumber(),
      detail: "unresolved (dynamic dispatch or external)",
    });
  }

  /** Resolve a call's callee to project-local callable declarations, if any. */
  function resolveUserCallee(ce: Node): { defs: Node[]; name: string } | null {
    if (!Node.isCallExpression(ce)) return null;
    const expr = ce.getExpression();
    let nameNode: Node;
    let name: string;
    if (Node.isIdentifier(expr)) {
      nameNode = expr;
      name = expr.getText();
    } else if (Node.isPropertyAccessExpression(expr)) {
      nameNode = expr.getNameNode();
      name = expr.getName();
    } else {
      return null; // element access / call chain / etc. — not name-resolvable
    }
    if (!Node.isIdentifier(nameNode)) return null;
    const defs = nameNode
      .getDefinitionNodes()
      .filter((d) => {
        const sf = d.getSourceFile();
        return !sf.isDeclarationFile() && !sf.isFromExternalLibrary();
      })
      .filter((d) => getCallableBody(d) !== undefined);
    if (defs.length === 0) return null;
    return { defs, name };
  }

  traceBody(input.bodyNode, input.file, 1);

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

/** The leftmost identifier of a receiver chain (`res.status(1).json` → `res`). */
function rootIdentifierName(expr: Node): string | undefined {
  let cur: Node = expr;
  while (
    Node.isPropertyAccessExpression(cur) ||
    Node.isElementAccessExpression(cur) ||
    Node.isCallExpression(cur) ||
    Node.isNonNullExpression(cur) ||
    Node.isParenthesizedExpression(cur)
  ) {
    cur = cur.getExpression();
  }
  return Node.isIdentifier(cur) ? cur.getText() : undefined;
}

/** Body-bearing node for a callable definition, following `const f = () => {}`. */
function getCallableBody(def: Node): Node | undefined {
  if (
    Node.isFunctionDeclaration(def) ||
    Node.isMethodDeclaration(def) ||
    Node.isFunctionExpression(def) ||
    Node.isArrowFunction(def)
  ) {
    return def.getBody();
  }
  if (Node.isVariableDeclaration(def)) {
    const init = def.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init.getBody();
    }
  }
  return undefined;
}

function looksLikeRepo(receiver: Node): boolean {
  const last = receiver.getText().split(".").pop() ?? receiver.getText();
  if (/repo|repository|prisma|manager|datasource|db$|store$/i.test(last)) return true;
  const typeText = receiver.getType().getText();
  return /\bRepository<|PrismaClient|EntityManager|DataSource\b/.test(typeText);
}

/** Entity from a repo receiver's declared generic, e.g. `Repository<User>` → `User`. */
function entityFromReceiver(receiver: Node): string | undefined {
  if (Node.isIdentifier(receiver)) {
    for (const def of receiver.getDefinitionNodes()) {
      if (
        Node.isVariableDeclaration(def) ||
        Node.isParameterDeclaration(def) ||
        Node.isPropertyDeclaration(def)
      ) {
        const typeText = def.getTypeNode()?.getText();
        const m = typeText?.match(/<\s*([A-Za-z_]\w*)/);
        if (m) return m[1];
      }
    }
  }
  const args = receiver.getType().getTypeArguments?.() ?? [];
  const sym = args[0]?.getSymbol()?.getName();
  return sym && sym !== "__type" ? sym : undefined;
}

const PRIMITIVE_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "any",
  "unknown",
  "void",
  "null",
  "undefined",
  "Promise",
  "Array",
  "object",
  "__type",
  "__object",
]);

function entityFromFirstArg(ce: Node): string | undefined {
  if (!Node.isCallExpression(ce)) return undefined;
  const arg = ce.getArguments()[0];
  if (!arg) return undefined;
  const sym = arg.getType().getSymbol()?.getName();
  return sym && !PRIMITIVE_TYPES.has(sym) ? sym : undefined;
}

function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
