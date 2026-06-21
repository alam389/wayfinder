# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`codebase-endpoint-explainer` (bin: `cee`) — an installable Agent Skill that explains a
web/agent codebase **one endpoint at a time** across Python, JS/TS, and Java. A deterministic
static extractor emits a **facts JSON**; the AI layer (the Skill, Phase 7) only narrates that
JSON — it never reads source directly. Anti-hallucination is the entire point: state only what's
statically resolvable, tag every fact with `confidence`, flag the rest as `opaque`.

TypeScript on Node 18+, ESM.

## Two documents drive everything — read them first

- **`SPEC.md`** — the shared contract: the `Facts` schema, the `LanguageAdapter` interface, the
  tracer rules, entity detection rules, and the non-negotiable principles. This is the source of
  truth. Do not duplicate it into code comments or restate it.
- **`PLAYBOOK.md`** — the phased build plan (8 phases). Each phase is self-contained with an
  Acceptance check and a Definition of Done gate. Build **one phase at a time**; do not advance
  until every DoD box is true. Phase 1 (scaffold) is done. Phases 2–8 add one adapter (or the
  packaging) each.

When `SPEC.md` and any other instruction conflict, `SPEC.md` wins.

## Commands

```bash
npm install            # first-time setup
npm run build          # tsup bundles src/cli.ts -> dist/cli.js (REQUIRED before any CLI run)
npm run typecheck      # tsc --noEmit (build via tsup does NOT type-check; run this separately)
npm test               # vitest run (one-shot)
npx vitest             # watch mode
npx vitest run test/dispatch.test.ts   # single test file

node dist/cli.js <dir> [--depth N]     # run the extractor; prints Facts JSON to stdout
TRACE_DEPTH=2 node dist/cli.js <dir>   # depth via env (the --depth flag overrides it; default 3)
```

Tests import from `src/` directly through vitest, so they do **not** need a build. The CLI does —
always `npm run build` before `node dist/cli.js`.

## Architecture

Data flow: `cli.ts` parses args → `dispatch(root)` walks files, skips the ignore-list, groups by
extension, hands each group to the adapter that claims it, merges results → `validateFacts` (zod)
→ print JSON.

- **`src/schema.ts`** — the `Facts` contract, defined **twice on purpose**: TypeScript interfaces
  (compile-time, erased at build) and a parallel `zod` schema (runtime). `validateFacts()` is the
  runtime gate. Keep the two definitions in lockstep. Per SPEC, adding a language must **not**
  change this shape — only set `language`/`framework` (rarely add a `kind`).
- **`src/registry.ts`** — `LanguageAdapter` interface, the `adapters` array (currently empty), and
  `dispatch()`. New languages/frameworks are added by writing an adapter and calling
  `registerAdapter()` — never by editing `dispatch`'s core logic. `IGNORE_DIRS` is the skip-list
  for the file walker.
- **`src/cli.ts`** — `cee` entry point; arg parsing + validate + print.
- **`src/wasm.ts`** — stub; Phase 4 fills it in to init web-tree-sitter and load python/java WASM
  grammars from `tree-sitter-wasms`.
- **`src/adapters/`** — does not exist yet; each phase adds one (e.g. `adapters/ts/express.ts`).
- **`samples/`** — per-adapter fixture apps (added per phase) that tests assert against.

## Architectural rules (from SPEC — enforce these in every adapter)

1. **Endpoint is the unit.** No whole-repo call graph. Root a bounded DFS (default depth 3) at each
   handler, over its **body only** — never decorators or the signature.
2. **Adapter registry, not a universal parser.** Per-language adapters, per-framework route
   extractors. Unify only at the schema boundary, never the parser.
3. **No LLM in the extractor.** Static analysis only.
4. **Confidence tiers are the contract.** `high` = directly resolved (e.g. ts-morph type checker);
   `medium` = heuristic; `low`/`opaque` = unresolved-but-flagged. **Never upgrade a tier**, never
   invent a target. Unresolved/dynamic dispatch stays `opaque` with the call text recorded.
5. **Per-language resolution strategy:** TS/JS uses `ts-morph` (semantic — type checker, symbol
   resolution) for `high`-confidence resolution. Python/Java use `web-tree-sitter` (syntactic,
   name-based symbol tables). Python optionally shells out to a bundled `extract_endpoints.py` ast
   sidecar when `python3` is on PATH, for higher fidelity — but both paths must emit the **same
   schema**.
6. Unknown language/framework → empty result + a warning, never a half-guessed trace.

## Gotchas

- `tsup` (esbuild) strips types without checking them — a build can succeed while types are broken.
  Run `npm run typecheck` as a separate gate.
- Internal imports use `.js` extensions (ESM requirement) even though the files are `.ts`.
- A `GateGuard` hook may intercept Bash/Write calls in some sessions, requiring you to state facts
  before file edits. Disable with `ECC_GATEGUARD=off` if it blocks setup work.
