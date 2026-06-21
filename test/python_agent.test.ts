import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { registerBuiltinAdapters } from "../src/adapters/index.js";
import { dispatch } from "../src/registry.js";
import { type Endpoint, type Facts, validateFacts } from "../src/schema.js";

const SAMPLE = fileURLToPath(new URL("../samples/python_agent", import.meta.url));

function find(endpoints: Endpoint[], method: string, path: string): Endpoint {
  const ep = endpoints.find((e) => e.method === method && e.path === path);
  if (!ep) throw new Error(`no endpoint ${method} ${path}`);
  return ep;
}

describe("Phase 5: Python/Flask + LangGraph linkage", () => {
  let facts: Facts;

  beforeAll(async () => {
    registerBuiltinAdapters();
    facts = await dispatch(SAMPLE);
  });

  it("emits schema-valid facts for python/flask only", () => {
    expect(() => validateFacts(facts)).not.toThrow();
    expect(facts.languages_detected).toEqual(["python"]);
    expect(facts.endpoints.every((e) => e.framework === "flask")).toBe(true);
  });

  it("extracts Flask routes with composed blueprint paths + methods", () => {
    const paths = facts.endpoints.map((e) => `${e.method} ${e.path}`).sort();
    expect(paths).toEqual([
      "GET /api/users/{user_id}",
      "GET /health",
      "POST /api/users",
      "POST /chat",
    ]);
  });

  it("captures Flask <int:id> converters as path params (the name)", () => {
    const get = find(facts.endpoints, "GET", "/api/users/{user_id}");
    expect(get.surface.path_params).toEqual(["user_id"]);
  });

  it("sets triggers_graph on the /chat handler that invokes the graph", () => {
    const chat = find(facts.endpoints, "POST", "/chat");
    expect(chat.triggers_graph).not.toBeNull();
    expect(chat.triggers_graph).toBe("chat_graph");
    expect(chat.steps.some((s) => s.kind === "graph")).toBe(true);
  });

  it("resolves a high-confidence call step into the service module", () => {
    const post = find(facts.endpoints, "POST", "/api/users");
    const call = post.steps.find((s) => s.kind === "call" && s.target === "persist_user");
    expect(call?.confidence).toBe("high");
    expect(call?.file).toBe("service.py");
    expect(post.steps.some((s) => s.kind === "db")).toBe(true);
  });

  it("best-effort detects the Pydantic body entity on the POST", () => {
    const post = find(facts.endpoints, "POST", "/api/users");
    expect(post.surface.body_entities).toEqual(["UserRequest"]);
    expect(post.entities).toContainEqual({
      name: "UserRequest",
      kind: "pydantic",
      direction: "in",
      confidence: "medium",
    });
  });

  it("extracts exactly one fully-populated agent graph", () => {
    expect(facts.agent_graphs).toHaveLength(1);
    const g = facts.agent_graphs[0];
    expect(g.framework).toBe("langgraph");
    expect(g.name).toBe("chat_graph");
    expect(g.file).toBe("graph.py");
    expect(g.state_schema).toBe("ChatState");
    expect(g.entry_point).toBe("classify");

    // nodes (>=2) with callables
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["answer", "classify", "escalate"]);
    expect(g.nodes.find((n) => n.name === "classify")?.callable).toBe("classify");

    // edges (>=1), START normalised
    expect(g.edges).toContainEqual({ source: "__start__", target: "classify" });

    // conditional edges with a branches dict
    expect(g.conditional_edges).toHaveLength(1);
    const ce = g.conditional_edges[0];
    expect(ce.source).toBe("classify");
    expect(ce.condition).toBe("route_intent");
    expect(ce.branches).toEqual({ answer: "answer", escalate: "escalate" });

    // checkpointer carries the MSSQL / SQL-Server reference
    expect(g.checkpointer).not.toBeNull();
    expect(g.checkpointer).toContain("MSSQL");
  });

  it("every step and entity carries a confidence tier", () => {
    for (const ep of facts.endpoints) {
      for (const s of ep.steps) expect(["high", "medium", "low"]).toContain(s.confidence);
      for (const e of ep.entities) expect(["high", "medium", "low"]).toContain(e.confidence);
    }
    for (const g of facts.agent_graphs) {
      for (const n of g.nodes) expect(typeof n.name).toBe("string");
    }
  });
});
