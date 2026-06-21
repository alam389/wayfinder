/**
 * ts-morph `Project` construction for a target repo.
 *
 * Per PLAYBOOK Phase 2: load the target repo's `tsconfig.json` when present
 * (so module/type resolution matches how the repo actually compiles); otherwise
 * fall back to a permissive ad-hoc project that still resolves intra-project
 * symbols — the only resolution the tracer depends on for `high` confidence.
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
import { Project, ts } from "ts-morph";

export function buildProject(files: string[], root: string): Project {
  const tsConfigFilePath = path.join(root, "tsconfig.json");

  let project: Project;
  if (existsSync(tsConfigFilePath)) {
    project = new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: false });
  } else {
    // No tsconfig in the target: a permissive in-process project. Bundler
    // resolution lets us follow `./foo.js` specifiers to their `.ts` sources,
    // matching the ESM convention this repo (and most modern repos) use.
    project = new Project({
      compilerOptions: {
        allowJs: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        noEmit: true,
      },
    });
  }

  // Ensure every file the walker handed us is in the project even if the
  // tsconfig `include` globs would have missed it (idempotent for ones already added).
  for (const file of files) {
    project.addSourceFileAtPathIfExists(file);
  }
  return project;
}
