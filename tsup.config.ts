import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Keep heavy/native-ish deps external; they resolve from node_modules at runtime.
  external: ["ts-morph", "web-tree-sitter", "tree-sitter-wasms"],
  banner: { js: "#!/usr/bin/env node" },
});
