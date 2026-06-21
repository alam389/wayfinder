/**
 * Python / Flask route extractor (PLAYBOOK Phase 5).
 *
 * Tree-sitter only (web-tree-sitter, WASM — no native build, flask need not be
 * installed). Detects `@app.route("/p", methods=[...])` and method-specific
 * `@app.get/post/...` decorators, composes Blueprint url_prefixes with the
 * `register_blueprint(..., url_prefix=...)` mount, reads the surface (Flask
 * `<int:id>` converters → path params; best-effort body entity / status), and
 * runs the shared Python tracer over each handler body. Disjoint from the FastAPI
 * adapter: that one only claims method-named decorators, so a pure Flask app
 * yields nothing there and there are no duplicate endpoints.
 *
 * LangGraph `agent_graphs` are attached to THIS adapter only (delegated to the
 * shared `langgraph` module) so graphs are emitted exactly once.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SyntaxNode, Tree } from "web-tree-sitter";
import type { LanguageAdapter } from "../../registry.js";
import type { AgentGraph, Endpoint, Entity, QueryParam } from "../../schema.js";
import { getParser } from "../../wasm.js";
import { classifyBases, classifyPyType, type PyEntityTable } from "./entities.js";
import { extractLangGraphs } from "./langgraph.js";
import { type PyFunctionDef, type PySymbolTables, tracePyHandler } from "./tracer.js";
import { descendantsOfType, fieldChild, namedChildren, nodeLine } from "./ts-helpers.js";

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head"]);

export const flaskAdapter: LanguageAdapter = {
  language: "python",
  extensions: new Set([".py"]),

  async detectFrameworks(files: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const file of files) {
      try {
        const text = await fs.readFile(file, "utf8");
        if (/from\s+flask|import\s+flask/i.test(text)) {
          found.add("flask");
          break;
        }
      } catch {
        // unreadable — ignore
      }
    }
    return found;
  },

  async extractEndpoints(files: string[], root: string, depth: number): Promise<Endpoint[]> {
    const pyFiles = files.filter((f) => f.toLowerCase().endsWith(".py"));
    if (pyFiles.length === 0) return [];
    return extractFlaskViaTreeSitter(pyFiles, root, depth);
  },

  /** Graphs are attached here only (single python adapter) — see langgraph.ts. */
  async extractAgentGraphs(files: string[], root: string): Promise<AgentGraph[]> {
    return extractLangGraphs(files, root);
  },
};

// ===========================================================================
// Tree-sitter path
// ===========================================================================

interface ParsedFile {
  file: string; // relative to root
  abs: string;
  tree: Tree;
}

/** A `<app>`/`<bp>` registration target: the var name and its composed url_prefix. */
interface RouteHost {
  /** Full prefix to prepend to routes on this var (blueprint prefix + mount prefix). */
  prefix: string;
  /** Whether this var is a Flask app (`Flask(__name__)`) vs a Blueprint. */
  isApp: boolean;
}

export async function extractFlaskViaTreeSitter(
  files: string[],
  root: string,
  depth: number,
): Promise<Endpoint[]> {
  const parser = await getParser("python");
  const parsed: ParsedFile[] = [];
  for (const abs of files) {
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    parsed.push({ file: path.relative(root, abs), abs, tree: parser.parse(text) });
  }

  // Only proceed if at least one file looks like Flask — keeps a non-Flask app
  // (e.g. the FastAPI sample) yielding zero Flask endpoints.
  const anyFlask = parsed.some((pf) => isFlaskFile(pf.tree));
  if (!anyFlask) return [];

  // Pass 1: entity table + per-file def symbol tables (for the tracer).
  const entityTable: PyEntityTable = new Map();
  const symbols: PySymbolTables = new Map();
  for (const pf of parsed) {
    collectClasses(pf, entityTable);
    symbols.set(pf.file, collectDefs(pf));
  }

  // Pass 2: route hosts. `app = Flask(__name__)` and
  // `bp = Blueprint("name", __name__, url_prefix="/users")` → base prefixes.
  const hosts = new Map<string, RouteHost>();
  for (const pf of parsed) collectHosts(pf, hosts);
  // `app.register_blueprint(bp, url_prefix="/api")` composes mount onto bp prefix.
  for (const pf of parsed) applyRegisterBlueprints(pf, hosts);

  // Pass 3: route decorators on functions.
  const endpoints: Endpoint[] = [];
  for (const pf of parsed) {
    for (const fnDef of descendantsOfType(pf.tree.rootNode, "function_definition")) {
      for (const dec of decoratorsOf(fnDef)) {
        const route = routeFromDecorator(dec);
        if (!route) continue;
        const host = hosts.get(route.receiver);
        if (!host) continue; // route on an unknown receiver — skip (never guess)
        const fullPath = normalizeConverters(joinPath(host.prefix, route.path));
        for (const method of route.methods) {
          endpoints.push(
            buildEndpoint({
              pf,
              fnDef,
              method,
              fullPath,
              decorator: dec,
              entityTable,
              symbols,
              depth,
            }),
          );
        }
      }
    }
  }
  return endpoints;
}

function isFlaskFile(tree: Tree): boolean {
  // Cheap structural check: an import of flask, or a Flask()/Blueprint() call.
  for (const imp of descendantsOfType(tree.rootNode, "import_from_statement")) {
    if (/\bflask\b/i.test(imp.text)) return true;
  }
  for (const imp of descendantsOfType(tree.rootNode, "import_statement")) {
    if (/\bflask\b/i.test(imp.text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// pass 1: classes + defs
// ---------------------------------------------------------------------------

function collectClasses(pf: ParsedFile, table: PyEntityTable): void {
  for (const cls of descendantsOfType(pf.tree.rootNode, "class_definition")) {
    const name = fieldChild(cls, "name")?.text;
    if (!name) continue;
    const kind = classifyBases(classBaseNames(cls));
    if (kind && !table.has(name)) table.set(name, kind);
  }
}

function classBaseNames(cls: SyntaxNode): string[] {
  const supers = fieldChild(cls, "superclasses");
  if (!supers) return [];
  const out: string[] = [];
  for (const arg of namedChildren(supers)) {
    if (arg.type === "identifier") out.push(arg.text);
    else if (arg.type === "attribute") {
      const attr = fieldChild(arg, "attribute");
      if (attr) out.push(attr.text);
    }
  }
  return out;
}

function collectDefs(pf: ParsedFile): Map<string, PyFunctionDef> {
  const defs = new Map<string, PyFunctionDef>();
  for (const fn of descendantsOfType(pf.tree.rootNode, "function_definition")) {
    const name = fieldChild(fn, "name")?.text;
    const body = fieldChild(fn, "body");
    if (name && body && !defs.has(name)) {
      defs.set(name, { name, node: fn, body, file: pf.file });
    }
  }
  return defs;
}

// ---------------------------------------------------------------------------
// pass 2: hosts (Flask app + Blueprints) and registration
// ---------------------------------------------------------------------------

function collectHosts(pf: ParsedFile, hosts: Map<string, RouteHost>): void {
  for (const assign of descendantsOfType(pf.tree.rootNode, "assignment")) {
    const left = fieldChild(assign, "left");
    const right = fieldChild(assign, "right");
    if (!left || !right || left.type !== "identifier" || right.type !== "call") continue;
    const callee = calleeName(right);
    if (callee === "Flask") {
      hosts.set(left.text, { prefix: "", isApp: true });
    } else if (callee === "Blueprint") {
      const prefix = kwargString(right, "url_prefix") ?? "";
      hosts.set(left.text, { prefix, isApp: false });
    }
  }
}

/** `app.register_blueprint(bp, url_prefix="/api")` composes mount onto bp's prefix. */
function applyRegisterBlueprints(pf: ParsedFile, hosts: Map<string, RouteHost>): void {
  for (const call of descendantsOfType(pf.tree.rootNode, "call")) {
    const fn = fieldChild(call, "function");
    if (fn?.type !== "attribute") continue;
    if (fieldChild(fn, "attribute")?.text !== "register_blueprint") continue;
    const args = fieldChild(call, "arguments");
    if (!args) continue;
    const first = namedChildren(args).find((a) => a.type === "identifier");
    const bpName = first?.text;
    if (!bpName) continue;
    const host = hosts.get(bpName);
    if (!host) continue;
    const mountPrefix = kwargString(call, "url_prefix");
    // Compose mount + blueprint prefix. If no mount prefix, blueprint prefix stands.
    host.prefix = mountPrefix != null ? joinPath(mountPrefix, host.prefix) : host.prefix;
  }
}

// ---------------------------------------------------------------------------
// pass 3: decorators + endpoint assembly
// ---------------------------------------------------------------------------

interface RouteInfo {
  receiver: string;
  methods: string[];
  path: string;
}

function decoratorsOf(fnDef: SyntaxNode): SyntaxNode[] {
  const parent = fnDef.parent;
  if (parent?.type !== "decorated_definition") return [];
  return namedChildren(parent).filter((c) => c.type === "decorator");
}

/**
 * `@app.route("/x", methods=["GET","POST"])` or `@bp.get("/y")` → route info.
 * `route` defaults to `["GET"]` when `methods=` is absent; method-specific
 * decorators carry the single method.
 */
function routeFromDecorator(dec: SyntaxNode): RouteInfo | null {
  const call = namedChildren(dec).find((c) => c.type === "call");
  if (!call) return null;
  const fn = fieldChild(call, "function");
  if (fn?.type !== "attribute") return null;
  const attr = fieldChild(fn, "attribute")?.text?.toLowerCase();
  const receiver = fieldChild(fn, "object")?.text;
  if (!attr || !receiver) return null;

  const args = fieldChild(call, "arguments");
  const pathArg = args ? namedChildren(args).find((a) => a.type === "string") : undefined;
  const routePath = pathArg ? stringValue(pathArg) : "";

  if (attr === "route") {
    const methods = methodsKwarg(call) ?? ["GET"];
    return { receiver, methods, path: routePath };
  }
  if (HTTP_METHODS.has(attr)) {
    return { receiver, methods: [attr.toUpperCase()], path: routePath };
  }
  return null;
}

/** `methods=["GET","POST"]` → `["GET","POST"]` (uppercased); null when absent. */
function methodsKwarg(call: SyntaxNode): string[] | null {
  const arg = findKwarg(call, "methods");
  if (!arg) return null;
  const value = fieldChild(arg, "value");
  if (!value || (value.type !== "list" && value.type !== "tuple" && value.type !== "set")) {
    return null;
  }
  const out: string[] = [];
  for (const item of namedChildren(value)) {
    if (item.type === "string") out.push(stringValue(item).toUpperCase());
  }
  return out.length > 0 ? out : null;
}

interface BuildArgs {
  pf: ParsedFile;
  fnDef: SyntaxNode;
  method: string;
  fullPath: string;
  decorator: SyntaxNode;
  entityTable: PyEntityTable;
  symbols: PySymbolTables;
  depth: number;
}

function buildEndpoint(a: BuildArgs): Endpoint {
  const { pf, fnDef } = a;
  const handler = fieldChild(fnDef, "name")?.text ?? "(anonymous)";
  const params = fieldChild(fnDef, "parameters");
  const body = fieldChild(fnDef, "body");

  const pathParams = extractPathParams(a.fullPath);

  // Best-effort body entity: a Pydantic-typed handler param, or a local assigned
  // from `request.get_json()` and cast to a known model (`Model(**data)`).
  let bodyEntity: string | null = null;
  if (params) {
    for (const p of namedChildren(params)) {
      const info = paramInfo(p);
      if (!info) continue;
      const typeName = info.typeText ? leadingTypeName(info.typeText) : null;
      if (typeName && a.entityTable.get(typeName) === "pydantic" && !bodyEntity) {
        bodyEntity = typeName;
        break;
      }
    }
  }
  if (!bodyEntity && body) {
    bodyEntity = bodyEntityFromJson(body, a.entityTable);
  }

  const trace = body
    ? tracePyHandler({ body, file: pf.file, maxDepth: a.depth, symbols: a.symbols })
    : { steps: [], entities: [], triggersGraph: null, warnings: [] };

  const entities: Entity[] = [];
  const seen = new Set<string>();
  const pushEntity = (e: Entity): void => {
    const key = `${e.name}|${e.direction}`;
    if (!seen.has(key)) {
      seen.add(key);
      entities.push(e);
    }
  };
  if (bodyEntity) {
    pushEntity({
      name: bodyEntity,
      kind: classifyPyType(bodyEntity, a.entityTable),
      direction: "in",
      confidence: "medium",
    });
  }
  for (const e of trace.entities) pushEntity(e);

  return {
    language: "python",
    framework: "flask",
    method: a.method,
    path: a.fullPath,
    handler,
    file: pf.file,
    line: nodeLine(a.decorator),
    surface: {
      path_params: pathParams,
      query_params: [] as QueryParam[],
      body_entities: bodyEntity ? [bodyEntity] : [],
      dependencies: [],
      response_model: null,
      status_code: null,
      tags: [],
    },
    steps: trace.steps,
    entities,
    triggers_graph: trace.triggersGraph,
    warnings: trace.warnings,
  };
}

/** Look for `Model(**data)` / `Model(...)` of a known Pydantic class in the body. */
function bodyEntityFromJson(body: SyntaxNode, table: PyEntityTable): string | null {
  for (const call of descendantsOfType(body, "call")) {
    const fn = fieldChild(call, "function");
    if (fn?.type !== "identifier") continue;
    if (table.get(fn.text) === "pydantic") return fn.text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// signature readers (subset of the FastAPI adapter's — Flask needs less)
// ---------------------------------------------------------------------------

interface ParamInfo {
  name: string;
  typeText: string | null;
}

function paramInfo(p: SyntaxNode): ParamInfo | null {
  switch (p.type) {
    case "identifier":
      return { name: p.text, typeText: null };
    case "typed_parameter": {
      const name = namedChildren(p).find((c) => c.type === "identifier")?.text;
      const typeText = fieldChild(p, "type")?.text ?? null;
      return name ? { name, typeText } : null;
    }
    case "default_parameter": {
      const name = fieldChild(p, "name")?.text;
      return name ? { name, typeText: null } : null;
    }
    case "typed_default_parameter": {
      const name = fieldChild(p, "name")?.text;
      const typeText = fieldChild(p, "type")?.text ?? null;
      return name ? { name, typeText } : null;
    }
    default:
      return null;
  }
}

function leadingTypeName(typeText: string): string | null {
  const m = typeText.match(/^([A-Za-z_]\w*)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// kwargs / strings / paths
// ---------------------------------------------------------------------------

function calleeName(call: SyntaxNode): string | null {
  const fn = fieldChild(call, "function");
  if (!fn) return null;
  if (fn.type === "attribute") return fieldChild(fn, "attribute")?.text ?? null;
  return fn.text;
}

function kwargString(call: SyntaxNode, key: string): string | null {
  const arg = findKwarg(call, key);
  if (!arg) return null;
  const value = fieldChild(arg, "value");
  return value && value.type === "string" ? stringValue(value) : null;
}

function findKwarg(call: SyntaxNode, key: string): SyntaxNode | null {
  const args = fieldChild(call, "arguments");
  if (!args) return null;
  for (const a of namedChildren(args)) {
    if (a.type !== "keyword_argument") continue;
    if (fieldChild(a, "name")?.text === key) return a;
  }
  return null;
}

function stringValue(node: SyntaxNode): string {
  const content = namedChildren(node).find((c) => c.type === "string_content");
  if (content) return content.text;
  return node.text.replace(/^[a-zA-Z]*['"]{1,3}/, "").replace(/['"]{1,3}$/, "");
}

/**
 * Flask converters: `/users/<int:id>` → `id`, `/p/<name>` → `name`. We capture
 * the parameter NAME (after the optional `converter:`), normalising the stored
 * path to FastAPI-style `{name}` so `path_params` and `path` agree.
 */
function extractPathParams(p: string): string[] {
  const out: string[] = [];
  for (const m of p.matchAll(/[<{](?:[A-Za-z_][\w]*:)?([A-Za-z_]\w*)[>}]/g)) out.push(m[1]);
  return out;
}

/** Rewrite Flask `<int:id>` / `<id>` converters to FastAPI-style `{id}` so the
 *  stored `path` and `path_params` agree across adapters. */
function normalizeConverters(p: string): string {
  return p.replace(/<(?:[A-Za-z_][\w]*:)?([A-Za-z_]\w*)>/g, "{$1}");
}

function joinPath(prefix: string, route: string): string {
  const a = (prefix ?? "").replace(/\/+$/, "");
  const b = route ? (route.startsWith("/") ? route : `/${route}`) : "";
  let joined = `${a}${b}`.replace(/\/{2,}/g, "/");
  if (joined.length > 1) joined = joined.replace(/\/$/, "");
  return joined === "" ? "/" : joined;
}
