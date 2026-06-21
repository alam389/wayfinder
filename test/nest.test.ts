import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { registerBuiltinAdapters } from "../src/adapters/index.js";
import { dispatch } from "../src/registry.js";
import { type Endpoint, type Facts, validateFacts } from "../src/schema.js";

const SAMPLE = fileURLToPath(new URL("../samples/ts_nest", import.meta.url));

function find(facts: Facts, method: string, path: string): Endpoint {
  const ep = facts.endpoints.find((e) => e.method === method && e.path === path);
  if (!ep) throw new Error(`no endpoint ${method} ${path}`);
  return ep;
}

describe("Phase 3: TS/NestJS adapter", () => {
  let facts: Facts;

  beforeAll(async () => {
    registerBuiltinAdapters();
    facts = await dispatch(SAMPLE);
  });

  it("emits schema-valid facts for the controller", () => {
    expect(() => validateFacts(facts)).not.toThrow();
    expect(facts.languages_detected).toEqual(["typescript"]);
    expect(facts.endpoints.every((e) => e.framework === "nestjs")).toBe(true);
  });

  it("composes controller-prefix + method-decorator paths", () => {
    const paths = facts.endpoints.map((e) => `${e.method} ${e.path}`).sort();
    expect(paths).toEqual(["GET /users/:id", "POST /users"]);
  });

  it("captures @Body() DTO as an `in` entity and injected providers as dependencies", () => {
    const post = find(facts, "POST", "/users");
    expect(post.surface.body_entities).toEqual(["CreateUserDto"]);
    expect(post.surface.dependencies).toEqual(["UsersService"]);
    expect(post.surface.status_code).toBe("201");
    expect(post.surface.response_model).toBe("User");
    expect(post.entities).toContainEqual({
      name: "CreateUserDto",
      kind: "interface",
      direction: "in",
      confidence: "high",
    });
  });

  it("resolves handler → injected service method as a high call step (DI via type checker)", () => {
    const post = find(facts, "POST", "/users");
    const call = post.steps.find((s) => s.kind === "call" && s.target === "create");
    expect(call).toBeDefined();
    expect(call?.confidence).toBe("high");
    expect(call?.file).toBe("src/users.service.ts");
    // recursion continues into the service: an ORM write hop on the User entity
    const db = post.steps.find((s) => s.kind === "db");
    expect(db?.confidence).toBe("medium");
    expect(post.entities).toContainEqual({
      name: "User",
      kind: "orm",
      direction: "write",
      confidence: "medium",
    });
  });

  it("extracts @Param + @Query surface and resolves the GET service hop", () => {
    const get = find(facts, "GET", "/users/:id");
    expect(get.surface.path_params).toEqual(["id"]);
    expect(get.surface.query_params).toEqual([{ name: "verbose", type: null }]);
    expect(get.surface.dependencies).toEqual(["UsersService"]);
    const call = get.steps.find((s) => s.kind === "call" && s.target === "findOne");
    expect(call?.confidence).toBe("high");
    expect(call?.file).toBe("src/users.service.ts");
  });

  it("every step and entity carries a confidence tier", () => {
    for (const ep of facts.endpoints) {
      for (const s of ep.steps) expect(["high", "medium", "low"]).toContain(s.confidence);
      for (const e of ep.entities) expect(["high", "medium", "low"]).toContain(e.confidence);
    }
  });
});
