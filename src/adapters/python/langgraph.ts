/**
 * LangGraph `StateGraph` extractor for Python (PLAYBOOK Phase 5).
 *
 * Syntactic (web-tree-sitter), independent of the ast sidecar: scans each `.py`
 * file for `StateGraph(...)` construction and the builder calls applied to that
 * variable — `add_node`, `add_edge`, `add_conditional_edges`, `set_entry_point`,
 * and `.compile(checkpointer=...)`. Emits one `AgentGraph` per StateGraph var.
 *
 * Resolution-tolerant and never inventive: `langgraph` need not be installed; an
 * unresolvable callable/condition/checkpointer is recorded as its source text (or
 * null), never guessed. `START`/`END` sentinels are normalised to `__start__` /
 * `__end__` so edges read consistently. Attached to exactly ONE python adapter
 * (the Flask adapter) so graphs are not double-counted.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SyntaxNode } from "web-tree-sitter";
import type { AgentGraph, AgentGraphConditionalEdge, AgentGraphEdge, AgentGraphNode } from "../../schema.js";
import { getParser } from "../../wasm.js";
import { descendantsOfType, fieldChild, namedChildren } from "./ts-helpers.js";

/** Builder state accumulated for a single `StateGraph` variable in one file. */
interface GraphBuilder {
  name: string; // the graph builder var, later overwritten by the compiled var if found
  file: string; // relative to root
  stateSchema: string | null;
  entryPoint: string | null;
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
  conditionalEdges: AgentGraphConditionalEdge[];
  checkpointer: string | null;
}

export async function extractLangGraphs(files: string[], root: string): Promise<AgentGraph[]> {
  const pyFiles = files.filter((f) => f.toLowerCase().endsWith(".py"));
  if (pyFiles.length === 0) return [];

  const parser = await getParser("python");
  const graphs: AgentGraph[] = [];

  for (const abs of pyFiles) {
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(root, abs);
    const tree = parser.parse(text);
    graphs.push(...extractFromTree(tree.rootNode, rel));
  }
  return graphs;
}

function extractFromTree(rootNode: SyntaxNode, file: string): AgentGraph[] {
  // Index module-level `name = <expr>` so a checkpointer passed as a bare var can
  // be resolved to its construction text (e.g. `checkpointer` → `MSSQLSaver(...)`).
  const assignText = new Map<string, string>();
  for (const assign of descendantsOfType(rootNode, "assignment")) {
    const left = fieldChild(assign, "left");
    const right = fieldChild(assign, "right");
    if (left?.type === "identifier" && right && !assignText.has(left.text)) {
      assignText.set(left.text, right.text);
    }
  }

  // Pass 1: discover StateGraph builder vars (`g = StateGraph(SomeState)`).
  const builders = new Map<string, GraphBuilder>(); // builder var → state
  for (const assign of descendantsOfType(rootNode, "assignment")) {
    const left = fieldChild(assign, "left");
    const right = fieldChild(assign, "right");
    if (!left || !right || left.type !== "identifier" || right.type !== "call") continue;
    if (calleeName(right) !== "StateGraph") continue;
    builders.set(left.text, {
      name: left.text,
      file,
      stateSchema: firstPositionalIdentifier(right),
      entryPoint: null,
      nodes: [],
      edges: [],
      conditionalEdges: [],
      checkpointer: null,
    });
  }
  if (builders.size === 0) return [];

  // Pass 2: builder method calls + `<var>.compile(...)` rebinds.
  for (const call of descendantsOfType(rootNode, "call")) {
    const fn = fieldChild(call, "function");
    if (fn?.type !== "attribute") continue;
    const receiver = fieldChild(fn, "object")?.text;
    const method = fieldChild(fn, "attribute")?.text;
    if (!receiver || !method) continue;
    const builder = builders.get(receiver);
    if (!builder) continue;

    const args = callArgs(call);
    switch (method) {
      case "add_node":
        applyAddNode(builder, args);
        break;
      case "add_edge":
        applyAddEdge(builder, args);
        break;
      case "add_conditional_edges":
        applyConditionalEdges(builder, args);
        break;
      case "set_entry_point":
        builder.entryPoint = stringOrNode(args[0]) ?? builder.entryPoint;
        break;
      case "set_finish_point":
        // recorded as an edge to the END sentinel for completeness
        {
          const src = stringOrNode(args[0]);
          if (src) builder.edges.push({ source: src, target: "__end__" });
        }
        break;
      default:
        break;
    }
  }

  // Pass 3: `compiled = g.compile(checkpointer=<expr>)` — capture the compiled var
  // name (preferred graph name) and the checkpointer expression text.
  for (const assign of descendantsOfType(rootNode, "assignment")) {
    const left = fieldChild(assign, "left");
    const right = fieldChild(assign, "right");
    if (!right || right.type !== "call") continue;
    const fn = fieldChild(right, "function");
    if (fn?.type !== "attribute" || fieldChild(fn, "attribute")?.text !== "compile") continue;
    const receiver = fieldChild(fn, "object")?.text;
    if (!receiver) continue;
    const builder = builders.get(receiver);
    if (!builder) continue;
    const checkpointer = resolveCheckpointer(kwargText(right, "checkpointer"), assignText);
    if (checkpointer) builder.checkpointer = checkpointer;
    if (left?.type === "identifier") builder.name = left.text;
  }

  // Also handle bare `g.compile(checkpointer=...)` (no assignment) for the checkpointer.
  for (const call of descendantsOfType(rootNode, "call")) {
    const fn = fieldChild(call, "function");
    if (fn?.type !== "attribute" || fieldChild(fn, "attribute")?.text !== "compile") continue;
    const receiver = fieldChild(fn, "object")?.text;
    const builder = receiver ? builders.get(receiver) : undefined;
    if (!builder || builder.checkpointer) continue;
    const checkpointer = resolveCheckpointer(kwargText(call, "checkpointer"), assignText);
    if (checkpointer) builder.checkpointer = checkpointer;
  }

  return [...builders.values()].map((b) => ({
    name: b.name,
    framework: "langgraph",
    file: b.file,
    state_schema: b.stateSchema,
    entry_point: b.entryPoint,
    nodes: b.nodes,
    edges: b.edges,
    conditional_edges: b.conditionalEdges,
    checkpointer: b.checkpointer,
  }));
}

// ---------------------------------------------------------------------------
// builder-call appliers
// ---------------------------------------------------------------------------

/** `g.add_node("name", callable)` — name from arg0, callable text from arg1 (or null). */
function applyAddNode(builder: GraphBuilder, args: SyntaxNode[]): void {
  const name = stringOrNode(args[0]);
  if (!name) return;
  // arg1 is the callable; a single-arg form (`add_node(fn)`) uses the fn name.
  let callable: string | null = null;
  if (args[1]) callable = nodeText(args[1]);
  else if (args[0] && args[0].type !== "string") callable = nodeText(args[0]);
  builder.nodes.push({ name, callable });
}

/** `g.add_edge("a","b")` / `g.add_edge(START,"a")` — sentinels normalised. */
function applyAddEdge(builder: GraphBuilder, args: SyntaxNode[]): void {
  const source = edgeNode(args[0]);
  const target = edgeNode(args[1]);
  if (source == null || target == null) return;
  builder.edges.push({ source, target });
  // `add_edge(START, "x")` doubles as the entry point if none set explicitly.
  if (source === "__start__" && !builder.entryPoint) builder.entryPoint = target;
}

/**
 * `g.add_conditional_edges("src", route_fn, {"k":"dest",...})` — condition is the
 * router fn text; branches map best-effort (tolerates a missing/non-literal map).
 */
function applyConditionalEdges(builder: GraphBuilder, args: SyntaxNode[]): void {
  const source = edgeNode(args[0]);
  if (source == null) return;
  const condition = args[1] ? nodeText(args[1]) : null;
  const branches: Record<string, string> = {};
  const mapping = args[2];
  if (mapping && mapping.type === "dictionary") {
    for (const pair of namedChildren(mapping)) {
      if (pair.type !== "pair") continue;
      const key = fieldChild(pair, "key");
      const value = fieldChild(pair, "value");
      const k = key ? stringOrNode(key) : null;
      const v = value ? edgeNode(value) : null;
      if (k != null && v != null) branches[k] = v;
    }
  }
  builder.conditionalEdges.push({ source, condition, branches });
}

// ---------------------------------------------------------------------------
// node/string helpers
// ---------------------------------------------------------------------------

function calleeName(call: SyntaxNode): string | null {
  const fn = fieldChild(call, "function");
  if (!fn) return null;
  if (fn.type === "attribute") return fieldChild(fn, "attribute")?.text ?? null;
  return fn.text;
}

/** Positional (non-keyword) call arguments, in order. */
function callArgs(call: SyntaxNode): SyntaxNode[] {
  const argList = fieldChild(call, "arguments");
  if (!argList) return [];
  return namedChildren(argList).filter((a) => a.type !== "keyword_argument");
}

/** First positional arg if it's an identifier/attribute (the StateGraph schema). */
function firstPositionalIdentifier(call: SyntaxNode): string | null {
  const args = callArgs(call);
  const a = args[0];
  if (!a) return null;
  if (a.type === "identifier") return a.text;
  if (a.type === "attribute") return a.text;
  return null;
}

/**
 * The checkpointer expression to record. If it's a bare local identifier we
 * resolve it to its assigned construction text (`checkpointer` → `MSSQLSaver(...)`)
 * so the recorded value carries the real backend reference; otherwise the call
 * text stands as-is. Never invents — falls back to the literal text.
 */
function resolveCheckpointer(
  text: string | null,
  assignText: Map<string, string>,
): string | null {
  if (!text) return null;
  if (/^[A-Za-z_]\w*$/.test(text)) {
    return assignText.get(text) ?? text;
  }
  return text;
}

/** A keyword arg's raw source text: `checkpointer=MSSQLSaver(conn)` → `MSSQLSaver(conn)`. */
function kwargText(call: SyntaxNode, key: string): string | null {
  const argList = fieldChild(call, "arguments");
  if (!argList) return null;
  for (const a of namedChildren(argList)) {
    if (a.type !== "keyword_argument") continue;
    if (fieldChild(a, "name")?.text !== key) continue;
    const value = fieldChild(a, "value");
    return value ? value.text : null;
  }
  return null;
}

/** Unwrap a string literal to its content; otherwise return the node's source text. */
function stringOrNode(node: SyntaxNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "string") return stringValue(node);
  return node.text;
}

/** Raw source text of a node (for callables / conditions). */
function nodeText(node: SyntaxNode): string {
  return node.text;
}

/**
 * An edge endpoint: a string literal's content, the `START`/`END` sentinels
 * normalised to `__start__`/`__end__`, or any other expression's text.
 */
function edgeNode(node: SyntaxNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "string") return stringValue(node);
  const text = node.text;
  if (text === "START") return "__start__";
  if (text === "END") return "__end__";
  return text;
}

/** Unwrap a tree-sitter `string` node to its content (handles quotes/prefix). */
function stringValue(node: SyntaxNode): string {
  const content = namedChildren(node).find((c) => c.type === "string_content");
  if (content) return content.text;
  return node.text.replace(/^[a-zA-Z]*['"]{1,3}/, "").replace(/['"]{1,3}$/, "");
}
