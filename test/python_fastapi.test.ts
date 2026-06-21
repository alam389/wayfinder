import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { registerBuiltinAdapters } from "../src/adapters/index.js";
import { extractViaTreeSitter } from "../src/adapters/python/fastapi.js";
import { dispatch } from "../src/registry.js";
import { type Endpoint, type Facts, validateFacts } from "../src/schema.js";

const SAMPLE = fileURLToPath(new URL("../samples/python_fastapi", import.meta.url));

function find(endpoints: Endpoint[], method: string, path: string): Endpoint {
  const ep = endpoints.find((e) => e.method === method && e.path === path);
  if (!ep) throw new Error(`no endpoint ${method} ${path}`);
  return ep;
}

describe("Phase 4: Python/FastAPI adapter (sidecar path)", () => {
  let facts: Facts;

  beforeAll(async () => {
    registerBuiltinAdapters();
    facts = await dispatch(SAMPLE);
  });

  it("emits schema-valid facts only for python", () => {
    expect(() => validateFacts(facts)).not.toThrow();
    expect(facts.languages_detected).toEqual(["python"]);
    expect(facts.endpoints.every((e) => e.framework === "fastapi")).toBe(true);
  });

  it("composes include_router(prefix) + APIRouter(prefix) into /api/users paths", () => {
    const paths = facts.endpoints.map((e) => `${e.method} ${e.path}`).sort();
    expect(paths).toEqual([
      "GET /api/users/{user_id}",
      "GET /health",
      "POST /api/users",
    ]);
  });

  it("captures Pydantic in/out entities and the response/status surface", () => {
    const post = find(facts.endpoints, "POST", "/api/users");
    expect(post.surface.body_entities).toEqual(["CreateUserRequest"]);
    expect(post.surface.response_model).toBe("UserResponse");
    expect(post.surface.status_code).toBe("201");
    expect(post.surface.dependencies).toContain("get_session");
    expect(post.entities).toContainEqual({
      name: "CreateUserRequest",
      kind: "pydantic",
      direction: "in",
      confidence: "high",
    });
    expect(post.entities).toContainEqual({
      name: "UserResponse",
      kind: "pydantic",
      direction: "out",
      confidence: "medium",
    });
  });

  it("resolves a high-confidence call step into the service module", () => {
    const post = find(facts.endpoints, "POST", "/api/users");
    const call = post.steps.find((s) => s.kind === "call" && s.target === "create_user");
    expect(call).toBeDefined();
    expect(call?.confidence).toBe("high");
    expect(call?.file).toBe("service.py");
  });

  it("tags a DB write step in the recursed service body", () => {
    const post = find(facts.endpoints, "POST", "/api/users");
    const db = post.steps.find((s) => s.kind === "db" && s.detail?.includes("write"));
    expect(db).toBeDefined();
    expect(db?.confidence).toBe("medium");
  });

  it("tags an ORM read entity for the GET", () => {
    const get = find(facts.endpoints, "GET", "/api/users/{user_id}");
    expect(get.surface.path_params).toEqual(["user_id"]);
    expect(get.entities).toContainEqual({
      name: "User",
      kind: "orm",
      direction: "read",
      confidence: "medium",
    });
  });

  it("flags the genuinely unresolved call as opaque (never invents a target)", () => {
    const post = find(facts.endpoints, "POST", "/api/users");
    const opaque = post.steps.find((s) => s.kind === "opaque" && s.target.includes("notify_external"));
    expect(opaque).toBeDefined();
    expect(opaque?.confidence).toBe("low");
  });

  it("every step and entity carries a confidence tier", () => {
    for (const ep of facts.endpoints) {
      for (const s of ep.steps) expect(["high", "medium", "low"]).toContain(s.confidence);
      for (const e of ep.entities) expect(["high", "medium", "low"]).toContain(e.confidence);
    }
  });
});

describe("Phase 4: tree-sitter fallback (no sidecar)", () => {
  let endpoints: Endpoint[];

  beforeAll(async () => {
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    const files: string[] = [];
    for (const entry of await fs.readdir(SAMPLE)) {
      if (entry.endsWith(".py")) files.push(path.join(SAMPLE, entry));
    }
    endpoints = await extractViaTreeSitter(files, SAMPLE, 3);
  });

  it("produces schema-valid facts with composed routes via tree-sitter only", () => {
    const facts = {
      schema_version: "1.0" as const,
      root: SAMPLE,
      languages_detected: ["python"],
      endpoint_count: endpoints.length,
      endpoints,
      agent_graphs: [],
      warnings: [],
    };
    expect(() => validateFacts(facts)).not.toThrow();
    const paths = endpoints.map((e) => `${e.method} ${e.path}`).sort();
    expect(paths).toEqual([
      "GET /api/users/{user_id}",
      "GET /health",
      "POST /api/users",
    ]);
  });

  it("resolves the cross-file high call step and Pydantic in entity without the sidecar", () => {
    const post = find(endpoints, "POST", "/api/users");
    const call = post.steps.find((s) => s.kind === "call" && s.target === "create_user");
    expect(call?.confidence).toBe("high");
    expect(call?.file).toBe("service.py");
    expect(post.surface.body_entities).toEqual(["CreateUserRequest"]);
    expect(post.steps.some((s) => s.kind === "opaque")).toBe(true);
  });
});
