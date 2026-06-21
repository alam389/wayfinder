/**
 * web-tree-sitter init stub.
 *
 * Phase 1 placeholder. Phase 4 fills this in: initialize web-tree-sitter and
 * load the python + java `.wasm` grammars from `tree-sitter-wasms`. Kept as a
 * stub so the build graph and import sites exist before the WASM work lands.
 */

let initialized = false;

/** Idempotent init. No-op until Phase 4 wires up web-tree-sitter. */
export async function initWasm(): Promise<void> {
  if (initialized) return;
  // TODO(phase-4): await Parser.init(); load python/java grammars from tree-sitter-wasms.
  initialized = true;
}

/** Returns the loaded parser for a language. Not implemented until Phase 4. */
export async function getParser(language: "python" | "java"): Promise<never> {
  throw new Error(
    `web-tree-sitter not yet implemented (requested grammar: ${language}); arrives in Phase 4`,
  );
}
