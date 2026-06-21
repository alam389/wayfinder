/**
 * web-tree-sitter init + grammar loading (PLAYBOOK Phase 4).
 *
 * Initializes web-tree-sitter once and caches a `Parser` per language with its
 * `.wasm` grammar (from `tree-sitter-wasms`) loaded. Paths are resolved at
 * runtime via `createRequire` so this works from the bundled `dist/cli.js` with
 * no native build — pure WASM. `web-tree-sitter`'s own runtime `.wasm` is passed
 * through `locateFile` to stay correct under bundling.
 */
import { createRequire } from "node:module";
import * as path from "node:path";
import Parser from "web-tree-sitter";

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;
const parserCache = new Map<string, Parser>();

/** Idempotent: initialize the web-tree-sitter runtime exactly once. */
export function initWasm(): Promise<void> {
  if (!initPromise) {
    // Resolve the runtime `tree-sitter.wasm` next to `web-tree-sitter`'s entry so
    // emscripten finds it regardless of cwd or how the CLI was bundled.
    const runtimeWasm = path.join(
      path.dirname(require.resolve("web-tree-sitter")),
      "tree-sitter.wasm",
    );
    initPromise = Parser.init({
      locateFile(scriptName: string) {
        return scriptName === "tree-sitter.wasm" ? runtimeWasm : scriptName;
      },
    });
  }
  return initPromise;
}

const GRAMMAR_WASM: Record<"python" | "java", string> = {
  python: "tree-sitter-wasms/out/tree-sitter-python.wasm",
  java: "tree-sitter-wasms/out/tree-sitter-java.wasm",
};

/** Returns a cached `Parser` with the requested grammar loaded. */
export async function getParser(language: "python" | "java"): Promise<Parser> {
  await initWasm();
  const cached = parserCache.get(language);
  if (cached) return cached;

  const wasmPath = require.resolve(GRAMMAR_WASM[language]);
  const lang = await Parser.Language.load(wasmPath);
  const parser = new Parser();
  parser.setLanguage(lang);
  parserCache.set(language, parser);
  return parser;
}
