/**
 * Python / FastAPI route extractor (PLAYBOOK Phase 4).
 *
 * Two interchangeable paths emit the *same* `Endpoint` schema:
 *   1. **Sidecar** (high fidelity): a stdlib-only `extract_endpoints.py` driven by
 *      Python's `ast`, used when `python3` is on PATH and `CEE_NO_SIDECAR` is unset.
 *      It resolves handler→service `call` steps across the package by name.
 *   2. **Tree-sitter** (fallback): web-tree-sitter (WASM, no native build). Detects
 *      `@app/@router.<method>` decorators, composes `APIRouter(prefix=...)` +
 *      `include_router(..., prefix=...)` mounts, reads surface from the signature,
 *      and runs the name-based Python tracer over the handler body.
 *
 * Both are resolution-tolerant and syntactic: fastapi/sqlalchemy need not be
 * installed. On any sidecar failure we fall back to tree-sitter and add a warning
 * — we never throw, and never invent a target.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SyntaxNode, Tree } from "web-tree-sitter";
import type { LanguageAdapter } from "../../registry.js";
import { type Endpoint, type Entity, type QueryParam, validateFacts } from "../../schema.js";
import { getParser } from "../../wasm.js";
import { classifyBases, classifyPyType, type PyEntityTable } from "./entities.js";
import {
  type PyFunctionDef,
  type PySymbolTables,
  tracePyHandler,
} from "./tracer.js";
import { descendantsOfType, fieldChild, namedChildren, nodeLine } from "./ts-helpers.js";

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head"]);

export const fastapiAdapter: LanguageAdapter = {
  language: "python",
  extensions: new Set([".py"]),

  async detectFrameworks(files: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const file of files) {
      try {
        const text = await fs.readFile(file, "utf8");
        if (/from\s+fastapi|import\s+fastapi/.test(text)) {
          found.add("fastapi");
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

    if (python3Available() && !process.env.CEE_NO_SIDECAR) {
      const viaSidecar = extractViaSidecar(pyFiles, root, depth);
      if (viaSidecar) return viaSidecar;
      // sidecar failed — fall through to tree-sitter (warning added below).
      const fallback = await extractViaTreeSitter(pyFiles, root, depth);
      for (const ep of fallback) {
        ep.warnings.push("python ast sidecar failed; used tree-sitter fallback");
      }
      return fallback;
    }

    return extractViaTreeSitter(pyFiles, root, depth);
  },
};

// ===========================================================================
// Sidecar path (Python ast — high fidelity)
// ===========================================================================

function python3Available(): boolean {
  try {
    const r = spawnSync("python3", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Resolve the bundled sidecar script next to its committed source. */
function sidecarPath(): string {
  // This module is bundled into dist/cli.js, so `import.meta.url` points at dist
  // at runtime. The `.py` is never bundled; it stays in the repo `src` tree. We
  // walk up from the module to the package root, then into src/.../sidecar.
  const here = fileURLToPath(import.meta.url);
  // dev (tsx/vitest): here === src/adapters/python/fastapi.ts → sibling sidecar/.
  const devCandidate = path.join(path.dirname(here), "sidecar", "extract_endpoints.py");
  // built (dist/cli.js): walk to package root, then into src/.
  const require = createRequire(import.meta.url);
  let pkgRoot: string;
  try {
    pkgRoot = path.dirname(require.resolve("../../../package.json"));
  } catch {
    pkgRoot = path.resolve(path.dirname(here), "..");
  }
  const builtCandidate = path.join(
    pkgRoot,
    "src",
    "adapters",
    "python",
    "sidecar",
    "extract_endpoints.py",
  );
  return path.dirname(here).includes(`${path.sep}src${path.sep}`) ? devCandidate : builtCandidate;
}

/**
 * Run the ast sidecar. Returns parsed endpoints on success, or `null` on any
 * failure (missing script, non-zero exit, bad JSON) so the caller can fall back.
 */
export function extractViaSidecar(files: string[], root: string, depth: number): Endpoint[] | null {
  const script = sidecarPath();
  const r = spawnSync("python3", [script, root, "--depth", String(depth)], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  // Validate by wrapping in a Facts envelope (reuses the canonical zod gate).
  try {
    const facts = validateFacts({
      schema_version: "1.0",
      root: path.resolve(root),
      languages_detected: ["python"],
      endpoint_count: parsed.length,
      endpoints: parsed,
      agent_graphs: [],
      warnings: [],
    });
    return facts.endpoints;
  } catch {
    return null;
  }
}

// ===========================================================================
// Tree-sitter path (web-tree-sitter — fallback)
// ===========================================================================

interface ParsedFile {
  file: string; // relative to root
  abs: string;
  tree: Tree;
}

export async function extractViaTreeSitter(
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

  // Pass 1: entity table + per-file def symbol tables (for the tracer).
  const entityTable: PyEntityTable = new Map();
  const symbols: PySymbolTables = new Map();
  for (const pf of parsed) {
    collectClasses(pf, entityTable);
    symbols.set(pf.file, collectDefs(pf));
  }

  // Pass 2: resolve router/app prefixes (APIRouter(prefix=...) + include_router).
  const prefixByRouter = new Map<string, string>(); // var name → composed prefix
  const appVars = new Set<string>();
  for (const pf of parsed) {
    collectRouters(pf, appVars, prefixByRouter);
  }
  for (const pf of parsed) {
    applyIncludeRouters(pf, prefixByRouter);
  }

  // Pass 3: route decorators on functions.
  const endpoints: Endpoint[] = [];
  for (const pf of parsed) {
    for (const fnDef of descendantsOfType(pf.tree.rootNode, "function_definition")) {
      for (const dec of decoratorsOf(fnDef)) {
        const route = routeFromDecorator(dec);
        if (!route) continue;
        const recvPrefix = appVars.has(route.receiver)
          ? ""
          : (prefixByRouter.get(route.receiver) ?? null);
        if (recvPrefix === null && !appVars.has(route.receiver)) continue;
        const fullPath = joinPath(recvPrefix ?? "", route.path);
        endpoints.push(
          buildEndpoint({
            pf,
            fnDef,
            method: route.method,
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
  return endpoints;
}

// ---------------------------------------------------------------------------
// pass 1: classes + defs
// ---------------------------------------------------------------------------

function collectClasses(pf: ParsedFile, table: PyEntityTable): void {
  for (const cls of descendantsOfType(pf.tree.rootNode, "class_definition")) {
    const nameNode = fieldChild(cls, "name");
    const name = nameNode?.text;
    if (!name) continue;
    const bases = classBaseNames(cls);
    const kind = classifyBases(bases);
    if (kind && !table.has(name)) table.set(name, kind);
  }
}

function classBaseNames(cls: SyntaxNode): string[] {
  const supers = fieldChild(cls, "superclasses");
  if (!supers) return [];
  const out: string[] = [];
  for (const arg of namedChildren(supers)) {
    // base may be `BaseModel` (identifier) or `pkg.BaseModel` (attribute).
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
// pass 2: routers / prefixes
// ---------------------------------------------------------------------------

/** `app = FastAPI()` → appVars; `router = APIRouter(prefix="/x")` → prefix map. */
function collectRouters(
  pf: ParsedFile,
  appVars: Set<string>,
  prefixByRouter: Map<string, string>,
): void {
  for (const assign of descendantsOfType(pf.tree.rootNode, "assignment")) {
    const left = fieldChild(assign, "left");
    const right = fieldChild(assign, "right");
    if (!left || !right || left.type !== "identifier" || right.type !== "call") continue;
    const callee = fieldChild(right, "function");
    const calleeName = callee?.type === "attribute" ? fieldChild(callee, "attribute")?.text : callee?.text;
    if (calleeName === "FastAPI") {
      appVars.add(left.text);
    } else if (calleeName === "APIRouter") {
      const prefix = kwargString(right, "prefix") ?? "";
      prefixByRouter.set(left.text, prefix);
    }
  }
}

/** `app.include_router(router, prefix="/api")` composes onto the router's prefix. */
function applyIncludeRouters(pf: ParsedFile, prefixByRouter: Map<string, string>): void {
  for (const call of descendantsOfType(pf.tree.rootNode, "call")) {
    const fn = fieldChild(call, "function");
    if (fn?.type !== "attribute") continue;
    if (fieldChild(fn, "attribute")?.text !== "include_router") continue;
    const args = fieldChild(call, "arguments");
    if (!args) continue;
    const first = namedChildren(args).find((a) => a.type === "identifier");
    const routerName = first?.text;
    if (!routerName) continue;
    const mountPrefix = kwargString(call, "prefix") ?? "";
    const existing = prefixByRouter.get(routerName) ?? "";
    prefixByRouter.set(routerName, joinPath(mountPrefix, existing));
  }
}

// ---------------------------------------------------------------------------
// pass 3: decorators + endpoint assembly
// ---------------------------------------------------------------------------

interface RouteInfo {
  receiver: string;
  method: string;
  path: string;
}

function decoratorsOf(fnDef: SyntaxNode): SyntaxNode[] {
  // In tree-sitter-python a decorated_definition wraps the function; its
  // `decorator` children precede the definition.
  const parent = fnDef.parent;
  if (parent?.type !== "decorated_definition") return [];
  return namedChildren(parent).filter((c) => c.type === "decorator");
}

/** `@app.get("/x")` / `@router.post("/y", status_code=201)` → route info. */
function routeFromDecorator(dec: SyntaxNode): RouteInfo | null {
  const call = namedChildren(dec).find((c) => c.type === "call");
  if (!call) return null;
  const fn = fieldChild(call, "function");
  if (fn?.type !== "attribute") return null;
  const method = fieldChild(fn, "attribute")?.text?.toLowerCase();
  const receiver = fieldChild(fn, "object")?.text;
  if (!method || !receiver || !HTTP_METHODS.has(method)) return null;
  const args = fieldChild(call, "arguments");
  const pathArg = args ? namedChildren(args).find((a) => a.type === "string") : undefined;
  const routePath = pathArg ? stringValue(pathArg) : "";
  return { receiver, method: method.toUpperCase(), path: routePath };
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
  const queryParams: QueryParam[] = [];
  const dependencies: string[] = [];
  let bodyEntity: string | null = null;

  if (params) {
    for (const p of namedChildren(params)) {
      const info = paramInfo(p);
      if (!info) continue;
      const { name, typeText, hasDefault, defaultText } = info;
      if (name === "self") continue;
      // Depends(...) → dependency
      if (defaultText && /\bDepends\s*\(/.test(defaultText)) {
        const m = defaultText.match(/Depends\s*\(\s*([A-Za-z_][\w.]*)/);
        if (m) dependencies.push(m[1].split(".").pop()!);
        continue;
      }
      // Pydantic-typed param → request body
      const typeName = typeText ? leadingTypeName(typeText) : null;
      if (typeName && a.entityTable.get(typeName) === "pydantic" && !bodyEntity) {
        bodyEntity = typeName;
        continue;
      }
      // path param already captured from the route string
      if (pathParams.includes(name)) continue;
      // otherwise a query param (best-effort type)
      if (!hasDefault && !typeName) {
        // positional with no annotation and not a path param — still a query param
      }
      queryParams.push({ name, type: typeText ?? null });
    }
  }

  const responseModel = kwargName(a.decorator, "response_model");
  const statusCode = kwargRaw(a.decorator, "status_code");

  const trace = body
    ? tracePyHandler({
        body,
        file: pf.file,
        maxDepth: a.depth,
        symbols: a.symbols,
      })
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
      confidence: "high",
    });
  }
  if (responseModel) {
    pushEntity({
      name: responseModel,
      kind: classifyPyType(responseModel, a.entityTable),
      direction: "out",
      confidence: "medium",
    });
  }
  for (const e of trace.entities) pushEntity(e);

  return {
    language: "python",
    framework: "fastapi",
    method: a.method,
    path: a.fullPath,
    handler,
    file: pf.file,
    line: nodeLine(a.decorator),
    surface: {
      path_params: pathParams,
      query_params: queryParams,
      body_entities: bodyEntity ? [bodyEntity] : [],
      dependencies,
      response_model: responseModel,
      status_code: statusCode,
      tags: [],
    },
    steps: trace.steps,
    entities,
    triggers_graph: trace.triggersGraph,
    warnings: trace.warnings,
  };
}

// ---------------------------------------------------------------------------
// signature + decorator readers
// ---------------------------------------------------------------------------

interface ParamInfo {
  name: string;
  typeText: string | null;
  hasDefault: boolean;
  defaultText: string | null;
}

function paramInfo(p: SyntaxNode): ParamInfo | null {
  switch (p.type) {
    case "identifier":
      return { name: p.text, typeText: null, hasDefault: false, defaultText: null };
    case "typed_parameter": {
      // child[0] is the name, `type` field is the annotation
      const name = namedChildren(p).find((c) => c.type === "identifier")?.text;
      const typeText = fieldChild(p, "type")?.text ?? null;
      return name ? { name, typeText, hasDefault: false, defaultText: null } : null;
    }
    case "default_parameter": {
      const name = fieldChild(p, "name")?.text;
      const value = fieldChild(p, "value")?.text ?? null;
      return name ? { name, typeText: null, hasDefault: true, defaultText: value } : null;
    }
    case "typed_default_parameter": {
      const name = fieldChild(p, "name")?.text;
      const typeText = fieldChild(p, "type")?.text ?? null;
      const value = fieldChild(p, "value")?.text ?? null;
      return name ? { name, typeText, hasDefault: true, defaultText: value } : null;
    }
    default:
      return null;
  }
}

/** Leading identifier of a type annotation (`List[User]`→`List`, `User`→`User`). */
function leadingTypeName(typeText: string): string | null {
  const m = typeText.match(/^([A-Za-z_]\w*)/);
  return m ? m[1] : null;
}

/** A keyword arg's string value: `prefix="/api"` → `/api`. */
function kwargString(call: SyntaxNode, key: string): string | null {
  const arg = findKwarg(call, key);
  if (!arg) return null;
  const value = fieldChild(arg, "value");
  return value && value.type === "string" ? stringValue(value) : null;
}

/** A keyword arg's identifier value: `response_model=User` → `User`. */
function kwargName(decOrCall: SyntaxNode, key: string): string | null {
  const call = decOrCall.type === "decorator" ? namedChildren(decOrCall).find((c) => c.type === "call") : decOrCall;
  if (!call) return null;
  const arg = findKwarg(call, key);
  const value = arg ? fieldChild(arg, "value") : null;
  if (!value) return null;
  if (value.type === "identifier") return value.text;
  if (value.type === "attribute") return fieldChild(value, "attribute")?.text ?? null;
  return null;
}

/** A keyword arg's raw text: `status_code=201` → `201`. */
function kwargRaw(decOrCall: SyntaxNode, key: string): string | null {
  const call = decOrCall.type === "decorator" ? namedChildren(decOrCall).find((c) => c.type === "call") : decOrCall;
  if (!call) return null;
  const arg = findKwarg(call, key);
  const value = arg ? fieldChild(arg, "value") : null;
  return value ? value.text : null;
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

// ---------------------------------------------------------------------------
// strings + paths
// ---------------------------------------------------------------------------

/** Unwrap a tree-sitter `string` node to its content (handles quotes/prefix). */
function stringValue(node: SyntaxNode): string {
  // tree-sitter-python exposes string_content children for the inner text.
  const content = namedChildren(node).find((c) => c.type === "string_content");
  if (content) return content.text;
  // fallback: strip surrounding quotes/prefix
  return node.text.replace(/^[a-zA-Z]*['"]{1,3}/, "").replace(/['"]{1,3}$/, "");
}

function extractPathParams(p: string): string[] {
  const out: string[] = [];
  for (const m of p.matchAll(/\{([A-Za-z0-9_]+)\}/g)) out.push(m[1]);
  return out;
}

function joinPath(prefix: string, route: string): string {
  const a = prefix.replace(/\/+$/, "");
  const b = route ? (route.startsWith("/") ? route : `/${route}`) : "";
  let joined = `${a}${b}`.replace(/\/{2,}/g, "/");
  if (joined.length > 1) joined = joined.replace(/\/$/, "");
  return joined === "" ? "/" : joined;
}
