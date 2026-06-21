import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { registerBuiltinAdapters } from "../src/adapters/index.js";
import { dispatch } from "../src/registry.js";
import { type Endpoint, type Facts, validateFacts } from "../src/schema.js";

const SAMPLE = fileURLToPath(new URL("../samples/java_spring", import.meta.url));

function find(endpoints: Endpoint[], method: string, path: string): Endpoint {
  const ep = endpoints.find((e) => e.method === method && e.path === path);
  if (!ep) throw new Error(`no endpoint ${method} ${path}`);
  return ep;
}

describe("Phase 6: Java/Spring adapter (tree-sitter)", () => {
  let facts: Facts;

  beforeAll(async () => {
    registerBuiltinAdapters();
    facts = await dispatch(SAMPLE);
  });

  it("emits schema-valid facts only for java/spring", () => {
    expect(() => validateFacts(facts)).not.toThrow();
    expect(facts.languages_detected).toEqual(["java"]);
    expect(facts.endpoints.every((e) => e.framework === "spring")).toBe(true);
    expect(facts.endpoints.every((e) => e.language === "java")).toBe(true);
  });

  it("composes class @RequestMapping + method mapping into full paths", () => {
    const paths = facts.endpoints.map((e) => `${e.method} ${e.path}`).sort();
    expect(paths).toEqual(["GET /api/users/{id}", "POST /api/users"]);
  });

  it("captures @RequestBody DTO as in entity and return type as out entity", () => {
    const post = find(facts.endpoints, "POST", "/api/users");
    expect(post.surface.body_entities).toEqual(["CreateUserRequest"]);
    expect(post.surface.response_model).toBe("User");
    expect(post.entities).toContainEqual({
      name: "CreateUserRequest",
      kind: "pojo",
      direction: "in",
      confidence: "high",
    });
    expect(post.entities).toContainEqual({
      name: "User",
      kind: "orm",
      direction: "out",
      confidence: "medium",
    });
  });

  it("unwraps ResponseEntity<User> in the return type", () => {
    const get = find(facts.endpoints, "GET", "/api/users/{id}");
    expect(get.surface.response_model).toBe("User");
  });

  it("lists the injected UserService in dependencies", () => {
    const post = find(facts.endpoints, "POST", "/api/users");
    expect(post.surface.dependencies).toContain("UserService");
  });

  it("resolves a handler→service call step (high or medium) into the service file", () => {
    const post = find(facts.endpoints, "POST", "/api/users");
    const call = post.steps.find((s) => s.kind === "call" && s.target.endsWith("createUser"));
    expect(call).toBeDefined();
    expect(["high", "medium"]).toContain(call?.confidence);
    expect(call?.file).toBe("UserService.java");
  });

  it("tags a DB write on the User entity in the recursed service body", () => {
    const post = find(facts.endpoints, "POST", "/api/users");
    const db = post.steps.find((s) => s.kind === "db" && s.detail?.includes("write"));
    expect(db).toBeDefined();
    expect(db?.confidence).toBe("medium");
    expect(post.entities).toContainEqual({
      name: "User",
      kind: "orm",
      direction: "write",
      confidence: "medium",
    });
  });

  it("flags a genuinely unresolved call as opaque (never invents a target)", () => {
    const post = find(facts.endpoints, "POST", "/api/users");
    const opaque = post.steps.find((s) => s.kind === "opaque" && s.target.includes("AuditLog"));
    expect(opaque).toBeDefined();
    expect(opaque?.confidence).toBe("low");
  });

  it("captures @PathVariable and @RequestParam surface on the GET", () => {
    const get = find(facts.endpoints, "GET", "/api/users/{id}");
    expect(get.surface.path_params).toEqual(["id"]);
    expect(get.surface.query_params).toContainEqual({ name: "verbose", type: "boolean" });
  });

  it("every step and entity carries a confidence tier", () => {
    for (const ep of facts.endpoints) {
      for (const s of ep.steps) expect(["high", "medium", "low"]).toContain(s.confidence);
      for (const e of ep.entities) expect(["high", "medium", "low"]).toContain(e.confidence);
    }
  });
});
