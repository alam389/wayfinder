#!/usr/bin/env python3
"""FastAPI endpoint extractor — the high-fidelity Python `ast` sidecar.

Stdlib only (no fastapi/sqlalchemy import needed — detection is syntactic). Emits
a JSON array of Endpoint objects on stdout, matching `src/schema.ts` exactly
(snake_case keys). Resolution is name-based across the scanned package: handler
bodies are traced (bounded DFS, default depth 3); calls into project-local `def`s
become `high`-confidence `call` steps and recurse, DB/ORM touches become `db`
steps with entity+direction, `.invoke/.ainvoke/.stream` set `triggers_graph`, and
everything unresolved stays `opaque`/`low` with the call text recorded.

Usage: python3 extract_endpoints.py <root> [--depth N]
"""
import ast
import json
import os
import sys

HTTP_METHODS = {"get", "post", "put", "delete", "patch", "options", "head"}
GRAPH_INVOKE = {"invoke", "ainvoke", "stream", "astream"}
DB_READ = {
    "query", "get", "first", "all", "filter", "filter_by", "find", "find_one",
    "scalar", "scalars", "execute", "select",
}
DB_WRITE = {
    "add", "add_all", "save", "commit", "delete", "merge", "insert", "update",
    "bulk_save_objects", "flush",
}
PYDANTIC_BASES = {"BaseModel"}
ORM_BASES = {"Base", "DeclarativeBase"}

IGNORE_DIRS = {
    "node_modules", ".venv", "site-packages", "dist", "build", "target",
    "__pycache__", ".git",
}


def iter_py_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]
        for fn in filenames:
            if fn.endswith(".py"):
                yield os.path.join(dirpath, fn)


def base_names(node):
    names = []
    for b in node.bases:
        if isinstance(b, ast.Name):
            names.append(b.id)
        elif isinstance(b, ast.Attribute):
            names.append(b.attr)
    return names


def classify_bases(names):
    for n in names:
        if n in PYDANTIC_BASES:
            return "pydantic"
    for n in names:
        if n in ORM_BASES:
            return "orm"
    return None


def attr_chain(node):
    """Dotted text for a Name/Attribute chain: db.query -> 'db.query'."""
    parts = []
    cur = node
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
    return ".".join(reversed(parts))


def leading_type_name(annotation):
    """Leading identifier of an annotation: List[User] -> 'List', User -> 'User'."""
    if isinstance(annotation, ast.Name):
        return annotation.id
    if isinstance(annotation, ast.Attribute):
        return annotation.attr
    if isinstance(annotation, ast.Subscript):
        return leading_type_name(annotation.value)
    return None


def looks_like_repo(recv_text):
    root = recv_text.split(".")[0].lower()
    last = recv_text.split(".")[-1].lower()
    keys = ("db", "session", "repo", "repository", "store")
    return root in keys or last in keys or any(k in root for k in keys)


def entity_from_call_args(call):
    for arg in call.args:
        if isinstance(arg, ast.Call):
            name = leading_type_name(arg.func) if not isinstance(arg.func, ast.Attribute) else None
            if isinstance(arg.func, ast.Name) and arg.func.id[:1].isupper():
                return arg.func.id
        if isinstance(arg, ast.Name) and arg.id[:1].isupper():
            return arg.id
    return None


def entity_from_receiver(recv_text):
    for seg in recv_text.split("."):
        if seg[:1].isupper():
            return seg
    return None


def truncate(text, n=80):
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"


class Index:
    """Project-wide name tables built from all scanned files."""

    def __init__(self, root):
        self.root = root
        self.func_defs = {}   # name -> (rel_file, FunctionDef)
        self.entity_kind = {}  # class name -> "pydantic" | "orm"
        self.modules = []      # list of (rel_file, ast.Module)

    def add_module(self, rel_file, tree):
        self.modules.append((rel_file, tree))
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.func_defs.setdefault(node.name, (rel_file, node))
            elif isinstance(node, ast.ClassDef):
                kind = classify_bases(base_names(node))
                if kind:
                    self.entity_kind.setdefault(node.name, kind)

    def classify_type(self, name):
        return self.entity_kind.get(name, "unknown")


def trace_handler(body_nodes, file, index, max_depth):
    steps = []
    entities = {}  # (name, direction) -> entity
    warnings = []
    triggers_graph = [None]
    visited = set()

    def add_step(depth, kind, target, confidence, sfile, line, detail):
        steps.append({
            "order": len(steps) + 1,
            "depth": depth,
            "kind": kind,
            "target": target,
            "confidence": confidence,
            "file": sfile,
            "line": line,
            "detail": detail,
        })

    def add_entity(name, direction):
        key = (name, direction)
        if key not in entities:
            entities[key] = {
                "name": name,
                "kind": "orm",
                "direction": direction,
                "confidence": "medium",
            }

    def calls_in(nodes):
        out = []
        for n in nodes:
            for sub in ast.walk(n):
                if isinstance(sub, ast.Call):
                    out.append(sub)
        out.sort(key=lambda c: (getattr(c, "lineno", 0), getattr(c, "col_offset", 0)))
        return out

    def classify(call, file, depth):
        func = call.func
        if isinstance(func, ast.Attribute):
            method = func.attr
            recv_text = attr_chain(func.value)
            if method in GRAPH_INVOKE:
                if triggers_graph[0] is None:
                    triggers_graph[0] = recv_text
                add_step(depth, "graph", recv_text + "." + method, "medium",
                         file, getattr(call, "lineno", None), "agent-graph invocation")
                return
            if (method in DB_READ or method in DB_WRITE) and looks_like_repo(recv_text):
                direction = "write" if method in DB_WRITE else "read"
                entity = entity_from_call_args(call) or entity_from_receiver(recv_text)
                detail = (direction + " " + entity) if entity else direction
                add_step(depth, "db", recv_text + "." + method, "medium",
                         file, getattr(call, "lineno", None), detail)
                if entity:
                    add_entity(entity, direction)
                return
            add_step(depth, "opaque", truncate(recv_text + "." + method), "low",
                     file, getattr(call, "lineno", None),
                     "unresolved (method / dynamic dispatch)")
            return

        if isinstance(func, ast.Name):
            name = func.id
            target = index.func_defs.get(name)
            if target:
                def_file, def_node = target
                add_step(depth, "call", name, "high", def_file,
                         getattr(def_node, "lineno", None), None)
                if depth < max_depth and id(def_node) not in visited:
                    visited.add(id(def_node))
                    for c in calls_in(def_node.body):
                        classify(c, def_file, depth + 1)
                return

        # Unresolved bare call (constructor / external / dynamic).
        add_step(depth, "opaque", truncate(attr_chain(func) or "<call>"), "low",
                 file, getattr(call, "lineno", None), "unresolved (external or dynamic)")

    for c in calls_in(body_nodes):
        classify(c, file, 1)

    return steps, list(entities.values()), triggers_graph[0], warnings


def route_from_decorator(dec):
    """@app.get('/x', status_code=201) -> (receiver, METHOD, path, decorator_call)."""
    if not isinstance(dec, ast.Call):
        return None
    func = dec.func
    if not isinstance(func, ast.Attribute):
        return None
    method = func.attr.lower()
    if method not in HTTP_METHODS:
        return None
    receiver = attr_chain(func.value)
    path = ""
    if dec.args and isinstance(dec.args[0], ast.Constant) and isinstance(dec.args[0].value, str):
        path = dec.args[0].value
    return receiver, method.upper(), path, dec


def kwarg(call, key):
    for kw in call.keywords:
        if kw.arg == key:
            return kw.value
    return None


def join_path(prefix, route):
    a = prefix.rstrip("/")
    b = route if route.startswith("/") else ("/" + route if route else "")
    joined = (a + b)
    while "//" in joined:
        joined = joined.replace("//", "/")
    if len(joined) > 1:
        joined = joined.rstrip("/")
    return joined or "/"


def extract_path_params(p):
    out = []
    buf = ""
    inside = False
    for ch in p:
        if ch == "{":
            inside = True
            buf = ""
        elif ch == "}":
            if inside and buf:
                out.append(buf)
            inside = False
        elif inside:
            buf += ch
    return out


def collect_routers(index):
    """Return (app_vars, prefix_by_router) composing include_router + APIRouter."""
    app_vars = set()
    prefix_by_router = {}
    # First: declarations.
    for rel_file, tree in index.modules:
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                callee = node.value.func
                callee_name = callee.attr if isinstance(callee, ast.Attribute) else (
                    callee.id if isinstance(callee, ast.Name) else None)
                targets = [t for t in node.targets if isinstance(t, ast.Name)]
                if not targets:
                    continue
                var = targets[0].id
                if callee_name == "FastAPI":
                    app_vars.add(var)
                elif callee_name == "APIRouter":
                    pfx = kwarg(node.value, "prefix")
                    prefix_by_router[var] = pfx.value if isinstance(pfx, ast.Constant) else ""
    # Second: include_router mounts compose onto existing router prefixes.
    for rel_file, tree in index.modules:
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                    and node.func.attr == "include_router" and node.args:
                first = node.args[0]
                if not isinstance(first, ast.Name):
                    continue
                mount = kwarg(node, "prefix")
                mount_pfx = mount.value if isinstance(mount, ast.Constant) else ""
                existing = prefix_by_router.get(first.id, "")
                prefix_by_router[first.id] = join_path(mount_pfx, existing)
    return app_vars, prefix_by_router


def build_endpoint(rel_file, fn, route, app_vars, prefix_by_router, index, depth):
    receiver, method, route_path, dec = route
    if receiver in app_vars:
        prefix = ""
    elif receiver in prefix_by_router:
        prefix = prefix_by_router[receiver]
    else:
        return None
    full_path = join_path(prefix, route_path)
    path_params = extract_path_params(full_path)

    query_params = []
    dependencies = []
    body_entity = None
    for arg in fn.args.args + fn.args.kwonlyargs:
        name = arg.arg
        if name in ("self", "cls"):
            continue
        ann = arg.annotation
        type_text = leading_type_name(ann) if ann else None
        # default may be Depends(...)
        # (kw defaults align with kwonlyargs; positional defaults align to the tail)
        if name in path_params:
            continue
        if type_text and index.entity_kind.get(type_text) == "pydantic" and body_entity is None:
            body_entity = type_text
            continue
        query_params.append({"name": name, "type": (ast.unparse(ann) if ann else None)})

    # Depends() dependencies from default values.
    defaults = list(fn.args.defaults)
    pos_args = fn.args.args
    if defaults:
        for arg, default in zip(pos_args[len(pos_args) - len(defaults):], defaults):
            if isinstance(default, ast.Call) and isinstance(default.func, ast.Name) \
                    and default.func.id == "Depends":
                if default.args and isinstance(default.args[0], (ast.Name, ast.Attribute)):
                    dependencies.append(attr_chain(default.args[0]).split(".")[-1])
                # remove from query params if added
                query_params = [q for q in query_params if q["name"] != arg.arg]
    for kw_arg, kw_default in zip(fn.args.kwonlyargs, fn.args.kw_defaults):
        if isinstance(kw_default, ast.Call) and isinstance(kw_default.func, ast.Name) \
                and kw_default.func.id == "Depends":
            if kw_default.args and isinstance(kw_default.args[0], (ast.Name, ast.Attribute)):
                dependencies.append(attr_chain(kw_default.args[0]).split(".")[-1])
            query_params = [q for q in query_params if q["name"] != kw_arg.arg]

    response_model = None
    rm = kwarg(dec, "response_model")
    if rm is not None:
        response_model = leading_type_name(rm)
    status_code = None
    sc = kwarg(dec, "status_code")
    if sc is not None:
        try:
            status_code = ast.unparse(sc)
        except Exception:
            status_code = None

    steps, trace_entities, triggers_graph, warnings = trace_handler(
        fn.body, rel_file, index, depth)

    entities = []
    seen = set()

    def push(e):
        key = (e["name"], e["direction"])
        if key not in seen:
            seen.add(key)
            entities.append(e)

    if body_entity:
        push({"name": body_entity, "kind": index.classify_type(body_entity),
              "direction": "in", "confidence": "high"})
    if response_model:
        push({"name": response_model, "kind": index.classify_type(response_model),
              "direction": "out", "confidence": "medium"})
    for e in trace_entities:
        push(e)

    return {
        "language": "python",
        "framework": "fastapi",
        "method": method,
        "path": full_path,
        "handler": fn.name,
        "file": rel_file,
        "line": dec.lineno,
        "surface": {
            "path_params": path_params,
            "query_params": query_params,
            "body_entities": [body_entity] if body_entity else [],
            "dependencies": dependencies,
            "response_model": response_model,
            "status_code": status_code,
            "tags": [],
        },
        "steps": steps,
        "entities": entities,
        "triggers_graph": triggers_graph,
        "warnings": warnings,
    }


def main(argv):
    root = None
    depth = 3
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--depth":
            i += 1
            depth = int(argv[i])
        elif root is None:
            root = a
        i += 1
    if root is None:
        print("[]")
        return 0
    root = os.path.abspath(root)

    index = Index(root)
    for abs_path in iter_py_files(root):
        try:
            with open(abs_path, "r", encoding="utf-8") as f:
                src = f.read()
            tree = ast.parse(src)
        except (SyntaxError, OSError, UnicodeDecodeError):
            continue
        rel = os.path.relpath(abs_path, root)
        index.add_module(rel, tree)

    app_vars, prefix_by_router = collect_routers(index)

    endpoints = []
    for rel_file, tree in index.modules:
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for dec in node.decorator_list:
                route = route_from_decorator(dec)
                if route is None:
                    continue
                ep = build_endpoint(rel_file, node, route, app_vars,
                                    prefix_by_router, index, depth)
                if ep is not None:
                    endpoints.append(ep)

    json.dump(endpoints, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
