/**
 * NestJS route extractor (PLAYBOOK Phase 3).
 *
 * Routes come from decorators: `@Controller("prefix")` on the class + a method
 * decorator (`@Get`, `@Post(":id")`, …) on each handler. Surface is read from
 * param decorators (`@Body()`/`@Param()`/`@Query()`) and the method return type;
 * constructor-injected providers become `dependencies`. The shared TS tracer
 * walks `this.<provider>.<method>(...)` calls — the type checker resolves the
 * receiver from the constructor param type, giving `high`-confidence hops into
 * the service layer (SPEC §tracer). Decorator/signature metadata is never traced.
 */
import * as path from "node:path";
import {
  type ClassDeclaration,
  type Decorator,
  type MethodDeclaration,
  Node,
  type ParameterDeclaration,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import type { LanguageAdapter } from "../../registry.js";
import type { Endpoint, Entity, QueryParam } from "../../schema.js";
import { classifyTypeName, collectOrmEntityNames } from "./entities.js";
import { buildProject } from "./project.js";
import { traceHandler } from "./tracer.js";

/** NestJS HTTP method decorators → HTTP verb. */
const METHOD_DECORATORS = new Map<string, string>([
  ["Get", "GET"],
  ["Post", "POST"],
  ["Put", "PUT"],
  ["Delete", "DELETE"],
  ["Patch", "PATCH"],
  ["Options", "OPTIONS"],
  ["Head", "HEAD"],
  ["All", "ALL"],
]);

const EXTENSIONS = new Set([".ts", ".tsx"]);
const TYPE_NAME_RE = /^([A-Za-z_]\w*)/;

export const nestAdapter: LanguageAdapter = {
  language: "typescript",
  extensions: EXTENSIONS,

  async detectFrameworks(): Promise<Set<string>> {
    // Detection is implicit: extractEndpoints only emits when a @Controller exists.
    return new Set();
  },

  async extractEndpoints(files: string[], root: string, depth: number): Promise<Endpoint[]> {
    const project = buildProject(files, root);
    const fileSet = new Set(files.map((f) => path.resolve(f)));
    const sources = project
      .getSourceFiles()
      .filter((sf) => !sf.isDeclarationFile() && !sf.isFromExternalLibrary())
      .filter((sf) => fileSet.has(path.resolve(sf.getFilePath())));

    const ormNames = collectOrmEntityNames(project);
    const endpoints: Endpoint[] = [];

    for (const sf of sources) {
      for (const cls of sf.getClasses()) {
        const controller = cls.getDecorator("Controller");
        if (!controller) continue;
        const prefix = controllerPrefix(controller);
        const dependencies = constructorDependencies(cls);

        for (const method of cls.getMethods()) {
          const httpDec = method
            .getDecorators()
            .find((d) => METHOD_DECORATORS.has(d.getName()));
          if (!httpDec) continue;

          const verb = METHOD_DECORATORS.get(httpDec.getName())!;
          const route = stringArg(httpDec) ?? "";
          const fullPath = joinPath(prefix, route);

          endpoints.push(
            buildEndpoint({ project, root, sf, cls, method, verb, fullPath, dependencies, ormNames, depth }),
          );
        }
      }
    }

    return endpoints;
  },
};

// ---------------------------------------------------------------------------
// endpoint assembly
// ---------------------------------------------------------------------------

interface BuildArgs {
  project: ReturnType<typeof buildProject>;
  root: string;
  sf: SourceFile;
  cls: ClassDeclaration;
  method: MethodDeclaration;
  verb: string;
  fullPath: string;
  dependencies: string[];
  ormNames: Set<string>;
  depth: number;
}

function buildEndpoint(a: BuildArgs): Endpoint {
  const { method } = a;

  // Surface from parameter decorators.
  const queryParams: QueryParam[] = [];
  const paramNames: string[] = [];
  let bodyEntity: string | null = null;
  for (const param of method.getParameters()) {
    const dec = param.getDecorators();
    const body = dec.find((d) => d.getName() === "Body");
    const paramDec = dec.find((d) => d.getName() === "Param");
    const queryDec = dec.find((d) => d.getName() === "Query");
    if (body && !bodyEntity) bodyEntity = typeName(param);
    if (paramDec) {
      const name = stringArg(paramDec);
      if (name) paramNames.push(name);
    }
    if (queryDec) {
      const name = stringArg(queryDec);
      if (name) queryParams.push({ name, type: null });
    }
  }

  // Path params: route-string `:id` first, then any @Param() names not covered.
  const pathParams = extractPathParams(a.fullPath);
  for (const n of paramNames) if (!pathParams.includes(n)) pathParams.push(n);

  const responseModel = returnTypeName(method);
  const statusCode = httpCode(method);

  const body = method.getBody();
  const trace = body
    ? traceHandler({
        bodyNode: body,
        file: rel(a.root, a.sf),
        root: a.root,
        maxDepth: a.depth,
        skipReceivers: new Set(),
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
      kind: classifyTypeName(a.project, bodyEntity, a.ormNames),
      direction: "in",
      confidence: "high",
    });
  }
  if (responseModel) {
    pushEntity({
      name: responseModel,
      kind: classifyTypeName(a.project, responseModel, a.ormNames),
      direction: "out",
      confidence: "medium",
    });
  }
  for (const e of trace.entities) pushEntity(e);

  return {
    language: "typescript",
    framework: "nestjs",
    method: a.verb,
    path: a.fullPath,
    handler: method.getName(),
    file: rel(a.root, a.sf),
    line: method.getNameNode().getStartLineNumber(),
    surface: {
      path_params: pathParams,
      query_params: queryParams,
      body_entities: bodyEntity ? [bodyEntity] : [],
      dependencies: a.dependencies,
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
// decorator + signature helpers
// ---------------------------------------------------------------------------

/** `@Controller("users")` or `@Controller({ path: "users" })` → `"users"`. */
function controllerPrefix(dec: Decorator): string {
  const literal = stringArg(dec);
  if (literal !== undefined) return literal;
  const obj = dec.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression);
  const pathProp = obj?.getProperty("path")?.asKind(SyntaxKind.PropertyAssignment);
  const value = pathProp?.getInitializer()?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
  return value ?? "";
}

/** First string-literal argument of a decorator call, if any. */
function stringArg(dec: Decorator): string | undefined {
  return dec.getArguments()[0]?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
}

/** Constructor-injected provider type names (the DI surface). */
function constructorDependencies(cls: ClassDeclaration): string[] {
  const ctor = cls.getConstructors()[0];
  if (!ctor) return [];
  const out: string[] = [];
  for (const param of ctor.getParameters()) {
    const name = typeName(param);
    if (name) out.push(name);
  }
  return out;
}

/** Leading type-name of a parameter's declared type (`CreateUserDto[]` → `CreateUserDto`). */
function typeName(param: ParameterDeclaration): string | null {
  const text = param.getTypeNode()?.getText();
  const m = text?.match(TYPE_NAME_RE);
  return m ? m[1] : null;
}

/** Method return type, unwrapping `Promise<…>` and `… | null` (`Promise<User>` → `User`). */
function returnTypeName(method: MethodDeclaration): string | null {
  let text = method.getReturnTypeNode()?.getText();
  if (!text) return null;
  text = text.trim();
  const promise = text.match(/^Promise<\s*(.+)>$/);
  if (promise) text = promise[1].trim();
  for (const part of text.split("|").map((p) => p.trim())) {
    if (part === "null" || part === "undefined" || part === "void") continue;
    const m = part.match(TYPE_NAME_RE);
    if (m && m[1] !== "Promise") return m[1];
  }
  return null;
}

/** `@HttpCode(201)` → `"201"`. */
function httpCode(method: MethodDeclaration): string | null {
  const dec = method.getDecorator("HttpCode");
  const arg = dec?.getArguments()[0]?.asKind(SyntaxKind.NumericLiteral);
  return arg ? arg.getText() : null;
}

// ---------------------------------------------------------------------------
// path + misc
// ---------------------------------------------------------------------------

function extractPathParams(p: string): string[] {
  const out: string[] = [];
  for (const m of p.matchAll(/:([A-Za-z0-9_]+)/g)) out.push(m[1]);
  return out;
}

function joinPath(prefix: string, route: string): string {
  const a = `/${prefix}`.replace(/\/+$/, "");
  const b = route ? (route.startsWith("/") ? route : `/${route}`) : "";
  let joined = `${a}${b}`.replace(/\/{2,}/g, "/");
  if (joined.length > 1) joined = joined.replace(/\/$/, "");
  return joined === "" ? "/" : joined;
}

function rel(root: string, sf: SourceFile): string {
  return path.relative(root, sf.getFilePath());
}
