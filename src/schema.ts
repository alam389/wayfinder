/**
 * Facts schema — the shared contract (SPEC.md §"Facts schema").
 *
 * This is the single source of truth for what the extractor emits and what the
 * skill narrates. Types and the zod schema below are kept in lockstep; adding a
 * language must NOT change this shape (only set `language`/`framework`).
 */
import { z } from "zod";

export const SCHEMA_VERSION = "1.0" as const;

// ---------------------------------------------------------------------------
// TypeScript interfaces (the contract, for editors and adapter authors)
// ---------------------------------------------------------------------------

export type Confidence = "high" | "medium" | "low";

export interface Step {
  order: number;
  depth: number;
  kind: "call" | "db" | "graph" | "external" | "opaque";
  target: string;
  confidence: Confidence;
  file: string | null;
  line: number | null;
  detail: string | null;
}

export interface Entity {
  name: string;
  kind: "pydantic" | "orm" | "interface" | "pojo" | "table" | "store" | "unknown";
  direction: "in" | "out" | "read" | "write" | "unknown";
  confidence: Confidence;
}

export interface QueryParam {
  name: string;
  type: string | null;
}

export interface Surface {
  path_params: string[];
  query_params: QueryParam[];
  body_entities: string[];
  dependencies: string[];
  response_model: string | null;
  status_code: string | null;
  tags: string[];
}

export interface Endpoint {
  language: "typescript" | "javascript" | "python" | "java";
  framework: string;
  method: string;
  path: string;
  handler: string;
  file: string;
  line: number;
  surface: Surface;
  steps: Step[];
  entities: Entity[];
  triggers_graph: string | null;
  warnings: string[];
}

export interface AgentGraphNode {
  name: string;
  callable: string | null;
}

export interface AgentGraphEdge {
  source: string;
  target: string;
}

export interface AgentGraphConditionalEdge {
  source: string;
  condition: string | null;
  branches: Record<string, string>;
}

export interface AgentGraph {
  name: string;
  framework: string;
  file: string;
  state_schema: string | null;
  entry_point: string | null;
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
  conditional_edges: AgentGraphConditionalEdge[];
  checkpointer: string | null;
}

export interface Facts {
  schema_version: typeof SCHEMA_VERSION;
  root: string;
  languages_detected: string[];
  endpoint_count: number;
  endpoints: Endpoint[];
  agent_graphs: AgentGraph[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// zod schema (runtime validation — mirrors the interfaces above exactly)
// ---------------------------------------------------------------------------

const confidenceSchema = z.enum(["high", "medium", "low"]);

const stepSchema = z.object({
  order: z.number().int(),
  depth: z.number().int(),
  kind: z.enum(["call", "db", "graph", "external", "opaque"]),
  target: z.string(),
  confidence: confidenceSchema,
  file: z.string().nullable(),
  line: z.number().nullable(),
  detail: z.string().nullable(),
});

const entitySchema = z.object({
  name: z.string(),
  kind: z.enum(["pydantic", "orm", "interface", "pojo", "table", "store", "unknown"]),
  direction: z.enum(["in", "out", "read", "write", "unknown"]),
  confidence: confidenceSchema,
});

const queryParamSchema = z.object({
  name: z.string(),
  type: z.string().nullable(),
});

const surfaceSchema = z.object({
  path_params: z.array(z.string()),
  query_params: z.array(queryParamSchema),
  body_entities: z.array(z.string()),
  dependencies: z.array(z.string()),
  response_model: z.string().nullable(),
  status_code: z.string().nullable(),
  tags: z.array(z.string()),
});

const endpointSchema = z.object({
  language: z.enum(["typescript", "javascript", "python", "java"]),
  framework: z.string(),
  method: z.string(),
  path: z.string(),
  handler: z.string(),
  file: z.string(),
  line: z.number(),
  surface: surfaceSchema,
  steps: z.array(stepSchema),
  entities: z.array(entitySchema),
  triggers_graph: z.string().nullable(),
  warnings: z.array(z.string()),
});

const agentGraphSchema = z.object({
  name: z.string(),
  framework: z.string(),
  file: z.string(),
  state_schema: z.string().nullable(),
  entry_point: z.string().nullable(),
  nodes: z.array(z.object({ name: z.string(), callable: z.string().nullable() })),
  edges: z.array(z.object({ source: z.string(), target: z.string() })),
  conditional_edges: z.array(
    z.object({
      source: z.string(),
      condition: z.string().nullable(),
      branches: z.record(z.string()),
    }),
  ),
  checkpointer: z.string().nullable(),
});

export const factsSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  root: z.string(),
  languages_detected: z.array(z.string()),
  endpoint_count: z.number().int(),
  endpoints: z.array(endpointSchema),
  agent_graphs: z.array(agentGraphSchema),
  warnings: z.array(z.string()),
});

/**
 * Validate an unknown value against the Facts contract. Throws a ZodError with
 * a readable path on mismatch; returns the typed value on success.
 */
export function validateFacts(value: unknown): Facts {
  return factsSchema.parse(value) as Facts;
}
