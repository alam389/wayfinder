/**
 * Java / Spring route extractor (PLAYBOOK Phase 6).
 *
 * Pure web-tree-sitter (WASM, no native build, nothing installed): detects
 * `@RestController`/`@Controller` classes, composes the class `@RequestMapping`
 * base path with each method mapping (`@GetMapping`/`@PostMapping("/{id}")`/...),
 * reads surface from the method signature (`@RequestBody`/`@PathVariable`/
 * `@RequestParam`, return type), resolves injected providers (`@Autowired` fields
 * + constructor params) into `dependencies`, and runs the name-based Java tracer
 * over each handler body. Syntactic and resolution-tolerant: we never throw, never
 * invent a target.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SyntaxNode, Tree } from "web-tree-sitter";
import type { LanguageAdapter } from "../../registry.js";
import type { Endpoint, Entity, QueryParam } from "../../schema.js";
import { getParser } from "../../wasm.js";
import { classifyJavaType, collectJavaClasses, type JavaEntityTable } from "./entities.js";
import {
  type JavaMethodDef,
  type JavaReceiverTypes,
  type JavaSymbolTables,
  traceJavaHandler,
} from "./tracer.js";
import {
  annotationArg,
  annotationName,
  annotationsOf,
  descendantsOfType,
  fieldChild,
  findAnnotation,
  hasAnyAnnotation,
  nodeLine,
} from "./java-helpers.js";

const CONTROLLER_ANNOTATIONS = new Set(["RestController", "Controller"]);
const MAPPING_METHODS: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
};

export const springAdapter: LanguageAdapter = {
  language: "java",
  extensions: new Set([".java"]),

  async detectFrameworks(files: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const file of files) {
      try {
        const text = await fs.readFile(file, "utf8");
        if (/org\.springframework|@RestController|@Controller/.test(text)) {
          found.add("spring");
          break;
        }
      } catch {
        // unreadable — ignore
      }
    }
    return found;
  },

  async extractEndpoints(files: string[], root: string, depth: number): Promise<Endpoint[]> {
    const javaFiles = files.filter((f) => f.toLowerCase().endsWith(".java"));
    if (javaFiles.length === 0) return [];
    return extractViaTreeSitter(javaFiles, root, depth);
  },
};

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
  const parser = await getParser("java");
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

  // Pass 1: entity table + per-file method symbol tables (for the tracer) + a
  // project-wide field-name→type map so receivers stay typed when the tracer
  // recurses into another class's body (e.g. the service's own repository field).
  const entityTable: JavaEntityTable = new Map();
  const symbols: JavaSymbolTables = new Map();
  const globalFieldTypes: JavaReceiverTypes = new Map();
  for (const pf of parsed) {
    collectJavaClasses(pf.tree.rootNode, entityTable);
    symbols.set(pf.file, collectMethods(pf));
    collectFieldTypes(pf.tree.rootNode, globalFieldTypes);
  }

  // Pass 2: controllers → endpoints.
  const endpoints: Endpoint[] = [];
  for (const pf of parsed) {
    for (const cls of descendantsOfType(pf.tree.rootNode, "class_declaration")) {
      if (!hasAnyAnnotation(cls, CONTROLLER_ANNOTATIONS)) continue;
      const basePath = classBasePath(cls);
      const injected = collectInjectedTypes(cls);
      // Seed with project-wide field types, then overlay this controller's own
      // fields/ctor params so the handler's direct receivers win.
      const receiverTypes: JavaReceiverTypes = new Map(globalFieldTypes);
      for (const [k, v] of injected.receiverTypes) receiverTypes.set(k, v);
      const dependencies = [...new Set(injected.dependencies)];

      const body = fieldChild(cls, "body");
      if (!body) continue;
      for (const method of body.namedChildren) {
        if (method.type !== "method_declaration") continue;
        const mapping = methodMapping(method);
        if (!mapping) continue;
        const fullPath = joinPath(basePath, mapping.path);
        endpoints.push(
          buildEndpoint({
            pf,
            method,
            httpMethod: mapping.method,
            fullPath,
            dependencies,
            receiverTypes,
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
// pass 1: methods
// ---------------------------------------------------------------------------

function collectMethods(pf: ParsedFile): Map<string, JavaMethodDef> {
  const defs = new Map<string, JavaMethodDef>();
  for (const m of descendantsOfType(pf.tree.rootNode, "method_declaration")) {
    const name = fieldChild(m, "name")?.text;
    const body = fieldChild(m, "body");
    if (name && body && !defs.has(name)) {
      defs.set(name, { name, node: m, body, file: pf.file });
    }
  }
  return defs;
}

/** Every `field_declaration` in the tree → name→simple type (project-wide). */
function collectFieldTypes(root: SyntaxNode, out: JavaReceiverTypes): void {
  for (const field of descendantsOfType(root, "field_declaration")) {
    const typeName = simpleTypeName(fieldChild(field, "type"));
    if (!typeName) continue;
    const declarator = field.namedChildren.find((c) => c.type === "variable_declarator");
    const varName = declarator ? fieldChild(declarator, "name")?.text : null;
    if (varName && !out.has(varName)) out.set(varName, typeName);
  }
}

// ---------------------------------------------------------------------------
// class-level: base path + injected dependencies
// ---------------------------------------------------------------------------

/** Class `@RequestMapping("/api")` / `(path=...)` / `(value=...)` → base path. */
function classBasePath(cls: SyntaxNode): string {
  const ann = findAnnotation(cls, "RequestMapping");
  if (!ann) return "";
  return annotationArg(ann, "value") ?? annotationArg(ann, "path") ?? "";
}

interface InjectedTypes {
  /** receiver var/field name → declared type (every field, for the tracer). */
  receiverTypes: JavaReceiverTypes;
  /** the injected provider type names (SPEC: @Autowired fields + ctor params). */
  dependencies: string[];
}

/**
 * Injected providers: `@Autowired` fields and constructor params of the
 * controller. Records the type of *every* field (so handler `this.field.x()`
 * calls resolve in the tracer), but only `@Autowired` fields and constructor
 * params count as `dependencies` per SPEC.
 */
function collectInjectedTypes(cls: SyntaxNode): InjectedTypes {
  const receiverTypes: JavaReceiverTypes = new Map();
  const dependencies: string[] = [];
  const body = fieldChild(cls, "body");
  if (!body) return { receiverTypes, dependencies };

  for (const member of body.namedChildren) {
    if (member.type === "field_declaration") {
      const typeName = simpleTypeName(fieldChild(member, "type"));
      if (!typeName) continue;
      const declarator = member.namedChildren.find((c) => c.type === "variable_declarator");
      const varName = declarator ? fieldChild(declarator, "name")?.text : null;
      if (varName) receiverTypes.set(varName, typeName);
      if (hasAnyAnnotation(member, new Set(["Autowired"]))) dependencies.push(typeName);
    }
    if (member.type === "constructor_declaration") {
      const params = fieldChild(member, "parameters");
      if (!params) continue;
      for (const p of params.namedChildren) {
        if (p.type !== "formal_parameter") continue;
        const typeName = simpleTypeName(fieldChild(p, "type"));
        const varName = fieldChild(p, "name")?.text;
        if (typeName) dependencies.push(typeName);
        if (typeName && varName) receiverTypes.set(varName, typeName);
      }
    }
  }
  return { receiverTypes, dependencies };
}

// ---------------------------------------------------------------------------
// method-level: mapping + endpoint assembly
// ---------------------------------------------------------------------------

interface MappingInfo {
  method: string;
  path: string;
}

/** `@GetMapping("/{id}")` / `@RequestMapping(method = RequestMethod.GET)` → mapping. */
function methodMapping(method: SyntaxNode): MappingInfo | null {
  for (const ann of annotationsOf(method)) {
    const name = annotationName(ann);
    if (!name) continue;
    if (name in MAPPING_METHODS) {
      const route = annotationArg(ann, "value") ?? annotationArg(ann, "path") ?? "";
      return { method: MAPPING_METHODS[name], path: route };
    }
    if (name === "RequestMapping") {
      const methodArg = annotationArg(ann, "method"); // RequestMethod.GET
      const verb = methodArg ? methodArg.split(".").pop()?.toUpperCase() : null;
      const route = annotationArg(ann, "value") ?? annotationArg(ann, "path") ?? "";
      return { method: verb ?? "GET", path: route };
    }
  }
  return null;
}

interface BuildArgs {
  pf: ParsedFile;
  method: SyntaxNode;
  httpMethod: string;
  fullPath: string;
  dependencies: string[];
  receiverTypes: JavaReceiverTypes;
  entityTable: JavaEntityTable;
  symbols: JavaSymbolTables;
  depth: number;
}

function buildEndpoint(a: BuildArgs): Endpoint {
  const { pf, method } = a;
  const handler = fieldChild(method, "name")?.text ?? "(anonymous)";
  const params = fieldChild(method, "parameters");
  const body = fieldChild(method, "body");

  const pathParams = extractPathParams(a.fullPath);
  const queryParams: QueryParam[] = [];
  let bodyEntity: string | null = null;
  // Locals visible to the tracer: controller fields/ctor params + handler params.
  const receiverTypes: JavaReceiverTypes = new Map(a.receiverTypes);

  if (params) {
    for (const p of params.namedChildren) {
      if (p.type !== "formal_parameter") continue;
      const typeNode = fieldChild(p, "type");
      const typeName = simpleTypeName(typeNode);
      const paramName = fieldChild(p, "name")?.text;
      if (paramName && typeName) receiverTypes.set(paramName, typeName);

      const requestBody = findAnnotation(p, "RequestBody");
      if (requestBody && typeName && !bodyEntity) {
        bodyEntity = typeName;
        continue;
      }
      const requestParam = findAnnotation(p, "RequestParam");
      if (requestParam) {
        const name = annotationArg(requestParam, "value") ?? paramName ?? "";
        if (name) queryParams.push({ name, type: typeNode?.text ?? null });
        continue;
      }
      // @PathVariable is reflected via the {x} in the path (path_params already).
    }
  }

  // Response model from the return type (unwrap ResponseEntity<T> / List<T>).
  const responseModel = responseModelFromReturn(fieldChild(method, "type"));

  const trace = body
    ? traceJavaHandler({
        body,
        file: pf.file,
        maxDepth: a.depth,
        symbols: a.symbols,
        receiverTypes,
      })
    : { steps: [], entities: [], warnings: [] };

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
      kind: classifyJavaType(bodyEntity, a.entityTable),
      direction: "in",
      confidence: "high",
    });
  }
  if (responseModel) {
    pushEntity({
      name: responseModel,
      kind: classifyJavaType(responseModel, a.entityTable),
      direction: "out",
      confidence: "medium",
    });
  }
  for (const e of trace.entities) pushEntity(e);

  return {
    language: "java",
    framework: "spring",
    method: a.httpMethod,
    path: a.fullPath,
    handler,
    file: pf.file,
    line: nodeLine(method),
    surface: {
      path_params: pathParams,
      query_params: queryParams,
      body_entities: bodyEntity ? [bodyEntity] : [],
      dependencies: a.dependencies,
      response_model: responseModel,
      status_code: null,
      tags: [],
    },
    steps: trace.steps,
    entities,
    triggers_graph: null,
    warnings: trace.warnings,
  };
}

// ---------------------------------------------------------------------------
// types + strings + paths
// ---------------------------------------------------------------------------

/** Simple (unqualified) name of a type node: `List<User>` → `List`, `User` → `User`. */
function simpleTypeName(typeNode: SyntaxNode | null): string | null {
  if (!typeNode) return null;
  switch (typeNode.type) {
    case "type_identifier":
      return typeNode.text;
    case "generic_type": {
      // first child is the base type identifier
      const base = typeNode.namedChildren.find((c) => c.type === "type_identifier");
      return base?.text ?? null;
    }
    case "scoped_type_identifier":
      return typeNode.text.split(".").pop() ?? null;
    default:
      // void_type, integral_type, etc. → not a named entity
      return null;
  }
}

/** Inner named type of a return type, unwrapping `ResponseEntity<T>`/`List<T>`. */
function responseModelFromReturn(typeNode: SyntaxNode | null): string | null {
  if (!typeNode) return null;
  if (typeNode.type === "generic_type") {
    const args = typeNode.namedChildren.find((c) => c.type === "type_arguments");
    if (args) {
      const inner = args.namedChildren.find(
        (c) => c.type === "type_identifier" || c.type === "generic_type",
      );
      if (inner) return responseModelFromReturn(inner);
    }
    // generic with no resolvable inner arg → fall back to the base name
    return simpleTypeName(typeNode);
  }
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "scoped_type_identifier") return typeNode.text.split(".").pop() ?? null;
  // void_type / primitives → no entity
  return null;
}

function extractPathParams(p: string): string[] {
  const out: string[] = [];
  for (const m of p.matchAll(/\{([A-Za-z0-9_]+)\}/g)) out.push(m[1]);
  return out;
}

function joinPath(base: string, route: string): string {
  const a = base.replace(/\/+$/, "");
  const b = route ? (route.startsWith("/") ? route : `/${route}`) : "";
  let joined = `${a}${b}`.replace(/\/{2,}/g, "/");
  if (joined.length > 1) joined = joined.replace(/\/$/, "");
  return joined === "" ? "/" : joined;
}
