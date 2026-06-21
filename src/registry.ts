/**
 * Adapter registry + file dispatch (SPEC.md §"LanguageAdapter" and §cli walk).
 *
 * Unify at the schema boundary, never the parser: each adapter owns its
 * language's extensions, framework detection, and endpoint extraction. The
 * registry just walks the tree, groups files by extension, and hands each group
 * to the adapter that claims it. No adapters are registered yet (Phase 1).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { SCHEMA_VERSION, type AgentGraph, type Endpoint, type Facts } from "./schema.js";

export interface LanguageAdapter {
  language: string;
  extensions: Set<string>;
  detectFrameworks(files: string[]): Promise<Set<string>>;
  extractEndpoints(files: string[], root: string, depth: number): Promise<Endpoint[]>;
  extractAgentGraphs?(files: string[], root: string): Promise<AgentGraph[]>;
}

/** Default bounded-trace depth when the CLI/env supplies none (SPEC: default 3). */
export const DEFAULT_TRACE_DEPTH = 3;

/** Directories never worth walking into. */
export const IGNORE_DIRS = new Set([
  "node_modules",
  ".venv",
  "site-packages",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".git",
]);

/** Empty registry — adapters are appended in later phases. */
export const adapters: LanguageAdapter[] = [];

export function registerAdapter(adapter: LanguageAdapter): void {
  adapters.push(adapter);
}

/** Recursively collect file paths under `root`, skipping the ignore list. */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip rather than crash the whole walk
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        await recurse(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await recurse(root);
  return out;
}

export interface DispatchOptions {
  depth?: number;
}

/**
 * Walk `root`, group files by extension, dispatch each group to the adapter
 * that owns it, merge results, and return a Facts object. With no adapters
 * registered this returns an empty-but-valid Facts shape.
 */
export async function dispatch(root: string, options: DispatchOptions = {}): Promise<Facts> {
  const absRoot = path.resolve(root);
  const depth = options.depth ?? DEFAULT_TRACE_DEPTH;
  const warnings: string[] = [];

  const allFiles = await walk(absRoot);

  // Group files by lowercased extension for adapter lookup.
  const byExt = new Map<string, string[]>();
  for (const file of allFiles) {
    const ext = path.extname(file).toLowerCase();
    if (!ext) continue;
    const list = byExt.get(ext);
    if (list) list.push(file);
    else byExt.set(ext, [file]);
  }

  const languagesDetected = new Set<string>();
  const endpoints: Endpoint[] = [];
  const agentGraphs: AgentGraph[] = [];

  for (const adapter of adapters) {
    // Collect files this adapter claims by extension.
    const claimed: string[] = [];
    for (const ext of adapter.extensions) {
      const list = byExt.get(ext.toLowerCase());
      if (list) claimed.push(...list);
    }
    if (claimed.length === 0) continue;

    languagesDetected.add(adapter.language);
    try {
      endpoints.push(...(await adapter.extractEndpoints(claimed, absRoot, depth)));
      if (adapter.extractAgentGraphs) {
        agentGraphs.push(...(await adapter.extractAgentGraphs(claimed, absRoot)));
      }
    } catch (err) {
      warnings.push(
        `adapter ${adapter.language} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    root: absRoot,
    languages_detected: [...languagesDetected],
    endpoint_count: endpoints.length,
    endpoints,
    agent_graphs: agentGraphs,
    warnings,
  };
}
