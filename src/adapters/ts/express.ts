/**
 * Express route extractor (PLAYBOOK Phase 2).
 *
 * Route discovery is syntactic and resolution-tolerant: a call is a route only
 * when its receiver resolves to a project-local `express()` app or `Router()`
 * variable, so it works whether or not `@types/express` is installed. Paths are
 * composed from `app.use("/prefix", router)` mounts. Surface (params, body type,
 * response, status) is read from the AST; the call graph is walked by the shared
 * TS tracer (SPEC §tracer). The model never sees source — only these facts.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import type { LanguageAdapter } from "../../registry.js";
import type { Endpoint, Entity, QueryParam } from "../../schema.js";
import { classifyTypeName, collectOrmEntityNames } from "./entities.js";
import { buildProject } from "./project.js";
import { traceHandler } from "./tracer.js";

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "head",
  "all",
]);

const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export const expressAdapter: LanguageAdapter = {
  language: "typescript",
  extensions: EXTENSIONS,

  async detectFrameworks(files: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const file of files) {
      try {
        const text = await fs.readFile(file, "utf8");
        if (/from\s+['"]express['"]|require\(\s*['"]express['"]\s*\)/.test(text)) {
          found.add("express");
          break;
        }
      } catch {
        // unreadable file — ignore
      }
    }
    return found;
  },

  async extractEndpoints(files: string[], root: string, depth: number): Promise<Endpoint[]> {
    const project = buildProject(files, root);
    const fileSet = new Set(files.map((f) => path.resolve(f)));
    const sources = project
      .getSourceFiles()
      .filter((sf) => !sf.isDeclarationFile() && !sf.isFromExternalLibrary())
      .filter((sf) => fileSet.has(path.resolve(sf.getFilePath())));

    const ormNames = collectOrmEntityNames(project);

    // Pass 1: classify express app / router variables across all sources.
    const appDeclKeys = new Set<string>();
    const routerDeclKeys = new Set<string>();
    for (const sf of sources) {
      for (const vd of sf.getVariableDeclarations()) {
        const init = vd.getInitializer();
        if (!init || !Node.isCallExpression(init)) continue;
        const callee = init.getExpression();
        if (Node.isIdentifier(callee) && callee.getText() === "express") {
          appDeclKeys.add(declKey(vd));
        } else if (isRouterFactory(callee)) {
          routerDeclKeys.add(declKey(vd));
        }
      }
    }

    // Pass 2: resolve mount prefixes from `<app|router>.use("/prefix", router)`.
    const prefixByRouter = new Map<string, string>();
    for (const sf of sources) {
      for (const ce of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = ce.getExpression();
        if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== "use") continue;
        const recvDecl = resolveVarDecl(expr.getExpression());
        if (!recvDecl) continue;
        const recvKey = declKey(recvDecl);
        const recvPrefix = appDeclKeys.has(recvKey)
          ? ""
          : routerDeclKeys.has(recvKey)
            ? (prefixByRouter.get(recvKey) ?? "")
            : null;
        if (recvPrefix === null) continue; // receiver isn't an app/router we track
        const args = ce.getArguments();
        const mount = args[0]?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
        if (mount === undefined) continue;
        for (const arg of args.slice(1)) {
          const targetDecl = resolveVarDecl(arg);
          if (targetDecl && routerDeclKeys.has(declKey(targetDecl))) {
            prefixByRouter.set(declKey(targetDecl), joinPath(recvPrefix, mount));
          }
        }
      }
    }

    // Pass 3: collect route registrations.
    const endpoints: Endpoint[] = [];
    for (const sf of sources) {
      for (const ce of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = ce.getExpression();
        if (!Node.isPropertyAccessExpression(expr)) continue;
        const method = expr.getName().toLowerCase();
        if (!HTTP_METHODS.has(method)) continue;

        const recvDecl = resolveVarDecl(expr.getExpression());
        if (!recvDecl) continue;
        const recvKey = declKey(recvDecl);

        const warnings: string[] = [];
        let prefix: string;
        if (appDeclKeys.has(recvKey)) {
          prefix = "";
        } else if (routerDeclKeys.has(recvKey)) {
          const mounted = prefixByRouter.get(recvKey);
          if (mounted === undefined) {
            warnings.push("router is never mounted; path may be incomplete");
          }
          prefix = mounted ?? "";
        } else {
          continue; // not an express app/router — ignore
        }

        const routeLiteral = ce.getArguments()[0]?.asKind(SyntaxKind.StringLiteral);
        if (!routeLiteral) continue;
        const fullPath = joinPath(prefix, routeLiteral.getLiteralValue());

        const handler = resolveHandler(ce);
        if (!handler) continue;

        endpoints.push(
          buildEndpoint({
            project,
            root,
            routeSf: sf,
            routeCall: ce,
            method: method === "all" ? "ALL" : method.toUpperCase(),
            fullPath,
            handler,
            ormNames,
            depth,
            routeWarnings: warnings,
          }),
        );
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
  routeSf: SourceFile;
  routeCall: Node;
  method: string;
  fullPath: string;
  handler: { node: Node; name: string };
  ormNames: Set<string>;
  depth: number;
  routeWarnings: string[];
}

function buildEndpoint(a: BuildArgs): Endpoint {
  const fn = a.handler.node;
  const params = getCallableParams(fn);
  const reqName = params[0]?.getName();
  const resName = params[1]?.getName();
  const nextName = params[2]?.getName();
  const body = getCallableBodyNode(fn);

  const pathParams = extractPathParams(a.fullPath);
  const queryParams = body && reqName ? extractQueryParams(body, reqName) : [];
  const bodyEntity = reqName ? extractBodyEntity(params[0], body, reqName) : null;
  const responseModel = body && resName ? extractResponseModel(body, resName) : null;
  const statusCode = body && resName ? extractStatusCode(body, resName) : null;

  const skipReceivers = new Set<string>(
    [reqName, resName, nextName].filter((n): n is string => Boolean(n)),
  );
  const trace =
    body !== undefined
      ? traceHandler({
          bodyNode: body,
          file: rel(a.root, a.routeSf),
          root: a.root,
          maxDepth: a.depth,
          skipReceivers,
        })
      : { steps: [], entities: [], triggersGraph: null, warnings: [] };

  // Entities: request body (in), response (out), plus DB-touched entities.
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

  const language = langForFile(a.routeSf.getFilePath());

  return {
    language,
    framework: "express",
    method: a.method,
    path: a.fullPath,
    handler: a.handler.name,
    file: rel(a.root, a.routeSf),
    line: a.routeCall.getStartLineNumber(),
    surface: {
      path_params: pathParams,
      query_params: queryParams,
      body_entities: bodyEntity ? [bodyEntity] : [],
      dependencies: [],
      response_model: responseModel,
      status_code: statusCode,
      tags: [],
    },
    steps: trace.steps,
    entities,
    triggers_graph: trace.triggersGraph,
    warnings: [...a.routeWarnings, ...trace.warnings],
  };
}

// ---------------------------------------------------------------------------
// surface extraction
// ---------------------------------------------------------------------------

function extractPathParams(p: string): string[] {
  const out: string[] = [];
  for (const m of p.matchAll(/:([A-Za-z0-9_]+)/g)) out.push(m[1]);
  return out;
}

function extractQueryParams(body: Node, reqName: string): QueryParam[] {
  const names = new Set<string>();
  // `req.query.NAME`
  for (const pae of body.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const inner = pae.getExpression();
    if (
      Node.isPropertyAccessExpression(inner) &&
      inner.getName() === "query" &&
      Node.isIdentifier(inner.getExpression()) &&
      inner.getExpression().getText() === reqName
    ) {
      names.add(pae.getName());
    }
  }
  // `const { a, b } = req.query`
  for (const vd of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = vd.getInitializer();
    if (
      init &&
      Node.isPropertyAccessExpression(init) &&
      init.getName() === "query" &&
      Node.isIdentifier(init.getExpression()) &&
      init.getExpression().getText() === reqName
    ) {
      const binding = vd.getNameNode().asKind(SyntaxKind.ObjectBindingPattern);
      if (binding) for (const el of binding.getElements()) names.add(el.getName());
    }
  }
  return [...names].map((name) => ({ name, type: null }));
}

const TYPE_NAME_RE = /^[A-Za-z_]\w*$/;

function extractBodyEntity(
  reqParam: Node | undefined,
  body: Node | undefined,
  reqName: string,
): string | null {
  // 1. `Request<Params, ResBody, ReqBody>` — third type argument is the body.
  const typeNode =
    reqParam && Node.isParameterDeclaration(reqParam) ? reqParam.getTypeNode() : undefined;
  const typeRef = typeNode?.asKind(SyntaxKind.TypeReference);
  if (typeRef && typeRef.getTypeName().getText() === "Request") {
    const targ = typeRef.getTypeArguments()[2]?.getText();
    if (targ && TYPE_NAME_RE.test(targ)) return targ;
  }
  if (!body) return null;
  // 2. `req.body as SomeType`
  for (const asExpr of body.getDescendantsOfKind(SyntaxKind.AsExpression)) {
    if (isReqBody(asExpr.getExpression(), reqName)) {
      const t = asExpr.getTypeNode()?.getText();
      if (t && TYPE_NAME_RE.test(t)) return t;
    }
  }
  // 3. `const x: SomeType = req.body`
  for (const vd of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = vd.getInitializer();
    if (init && isReqBody(init, reqName)) {
      const t = vd.getTypeNode()?.getText();
      if (t && TYPE_NAME_RE.test(t)) return t;
    }
  }
  return null;
}

function isReqBody(node: Node, reqName: string): boolean {
  return (
    Node.isPropertyAccessExpression(node) &&
    node.getName() === "body" &&
    Node.isIdentifier(node.getExpression()) &&
    node.getExpression().getText() === reqName
  );
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

function extractResponseModel(body: Node, resName: string): string | null {
  for (const ce of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = ce.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    const m = expr.getName();
    if (m !== "json" && m !== "send") continue;
    if (rootIdentifierName(expr) !== resName) continue;
    const arg = ce.getArguments()[0];
    if (!arg) continue;
    let type = arg.getType();
    if (type.isArray()) type = type.getArrayElementTypeOrThrow();
    const sym = type.getSymbol()?.getName();
    if (sym && !PRIMITIVE_TYPES.has(sym)) return sym;
  }
  return null;
}

function extractStatusCode(body: Node, resName: string): string | null {
  for (const ce of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = ce.getExpression();
    if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== "status") continue;
    if (rootIdentifierName(expr) !== resName) continue;
    const arg = ce.getArguments()[0]?.asKind(SyntaxKind.NumericLiteral);
    if (arg) return arg.getText();
  }
  return null;
}

// ---------------------------------------------------------------------------
// resolution helpers
// ---------------------------------------------------------------------------

function isRouterFactory(callee: Node): boolean {
  if (Node.isIdentifier(callee)) return callee.getText() === "Router";
  if (Node.isPropertyAccessExpression(callee)) return callee.getName() === "Router";
  return false;
}

/** Resolve an identifier to its backing `VariableDeclaration`, if any. */
function resolveVarDecl(node: Node): Node | undefined {
  if (!Node.isIdentifier(node)) return undefined;
  for (const def of node.getDefinitionNodes()) {
    if (Node.isVariableDeclaration(def)) return def;
  }
  return undefined;
}

/** The handler is the last function-like argument (Express puts middleware first). */
function resolveHandler(ce: Node): { node: Node; name: string } | undefined {
  if (!Node.isCallExpression(ce)) return undefined;
  const args = ce.getArguments();
  for (let i = args.length - 1; i >= 1; i--) {
    const a = args[i];
    if (Node.isArrowFunction(a) || Node.isFunctionExpression(a)) {
      const named = Node.isFunctionExpression(a) ? a.getName() : undefined;
      return { node: a, name: named || "(anonymous)" };
    }
    if (Node.isIdentifier(a)) {
      for (const def of a.getDefinitionNodes()) {
        if (getCallableBodyNode(def)) return { node: def, name: a.getText() };
      }
    }
  }
  return undefined;
}

function getCallableParams(fn: Node) {
  if (
    Node.isArrowFunction(fn) ||
    Node.isFunctionExpression(fn) ||
    Node.isFunctionDeclaration(fn) ||
    Node.isMethodDeclaration(fn)
  ) {
    return fn.getParameters();
  }
  if (Node.isVariableDeclaration(fn)) {
    const init = fn.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init.getParameters();
    }
  }
  return [];
}

function getCallableBodyNode(fn: Node): Node | undefined {
  if (
    Node.isArrowFunction(fn) ||
    Node.isFunctionExpression(fn) ||
    Node.isFunctionDeclaration(fn) ||
    Node.isMethodDeclaration(fn)
  ) {
    return fn.getBody();
  }
  if (Node.isVariableDeclaration(fn)) {
    const init = fn.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init.getBody();
    }
  }
  return undefined;
}

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

// ---------------------------------------------------------------------------
// path + misc
// ---------------------------------------------------------------------------

function joinPath(prefix: string, route: string): string {
  const a = prefix.replace(/\/+$/, "");
  const b = route.startsWith("/") ? route : `/${route}`;
  let joined = `${a}${b}`.replace(/\/{2,}/g, "/");
  if (joined.length > 1) joined = joined.replace(/\/$/, "");
  return joined === "" ? "/" : joined;
}

function declKey(node: Node): string {
  return `${node.getSourceFile().getFilePath()}#${node.getStart()}`;
}

function rel(root: string, sf: SourceFile): string {
  return path.relative(root, sf.getFilePath());
}

function langForFile(file: string): "typescript" | "javascript" {
  return /\.(ts|tsx)$/i.test(file) ? "typescript" : "javascript";
}
