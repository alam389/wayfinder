import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { registerBuiltinAdapters } from "../src/adapters/index.js";
import { dispatch } from "../src/registry.js";
import { type Endpoint, type Facts, validateFacts } from "../src/schema.js";

const SAMPLE = fileURLToPath(new URL("../samples/ts_express", import.meta.url));

function find(facts: Facts, method: string, path: string): Endpoint {
  const ep = facts.endpoints.find((e) => e.method === method && e.path === path);
  if (!ep) throw new Error(`no endpoint ${method} ${path}`);
  return ep;
}

describe("Phase 2: TS/Express adapter", () => {
  let facts: Facts;

  beforeAll(async () => {
    registerBuiltinAdapters();
    facts = await dispatch(SAMPLE);
  });

  it("emits schema-valid facts", () => {
    expect(() => validateFacts(facts)).not.toThrow();
    expect(facts.languages_detected).toEqual(["typescript"]);
  });

  it("composes router-mounted and app-level paths", () => {
    const paths = facts.endpoints.map((e) => `${e.method} ${e.path}`).sort();
    expect(paths).toEqual([
      "GET /api/users/:id",
      "GET /health",
      "POST /api/users",
    ]);
  });

  it("extracts the POST surface: typed body, response, status", () => {
    const post = find(facts, "POST", "/api/users");
    expect(post.framework).toBe("express");
    expect(post.surface.body_entities).toEqual(["CreateUserRequest"]);
    expect(post.surface.response_model).toBe("User");
    expect(post.surface.status_code).toBe("201");
    expect(post.entities).toContainEqual({
      name: "CreateUserRequest",
      kind: "interface",
      direction: "in",
      confidence: "high",
    });
  });

  it("resolves a high-confidence call step into the service layer (ts-morph)", () => {
    const post = find(facts, "POST", "/api/users");
    const call = post.steps.find((s) => s.kind === "call" && s.target === "createUser");
    expect(call).toBeDefined();
    expect(call?.confidence).toBe("high");
    expect(call?.file).toBe("src/userService.ts");
  });

  it("tags the ORM write and its entity direction", () => {
    const post = find(facts, "POST", "/api/users");
    const db = post.steps.find((s) => s.kind === "db");
    expect(db?.confidence).toBe("medium");
    expect(db?.target).toBe("userRepository.save");
    expect(post.entities).toContainEqual({
      name: "User",
      kind: "orm",
      direction: "write",
      confidence: "medium",
    });
  });

  it("flags unresolved dynamic dispatch as opaque (never invents a target)", () => {
    const post = find(facts, "POST", "/api/users");
    const opaque = post.steps.find((s) => s.kind === "opaque");
    expect(opaque).toBeDefined();
    expect(opaque?.confidence).toBe("low");
    expect(opaque?.target).toContain("hooks");
  });

  it("extracts path + query params and a read hop for the GET", () => {
    const get = find(facts, "GET", "/api/users/:id");
    expect(get.surface.path_params).toEqual(["id"]);
    expect(get.surface.query_params).toEqual([{ name: "verbose", type: null }]);
    const call = get.steps.find((s) => s.kind === "call" && s.target === "getUser");
    expect(call?.confidence).toBe("high");
    const db = get.steps.find((s) => s.kind === "db");
    expect(db?.target).toBe("userRepository.findOne");
    expect(get.entities).toContainEqual({
      name: "User",
      kind: "orm",
      direction: "read",
      confidence: "medium",
    });
  });

  it("every step and entity carries a confidence tier", () => {
    for (const ep of facts.endpoints) {
      for (const s of ep.steps) expect(["high", "medium", "low"]).toContain(s.confidence);
      for (const e of ep.entities) expect(["high", "medium", "low"]).toContain(e.confidence);
    }
  });
});
