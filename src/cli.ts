/**
 * `cee` CLI entry point.
 *
 * Usage: cee <root> [--depth N]
 * Walks <root>, dispatches files to language adapters, validates the resulting
 * Facts against the zod schema, and prints the JSON to stdout. Depth can also be
 * set via the TRACE_DEPTH env var (default 3); the explicit flag wins.
 */
import { dispatch } from "./registry.js";
import { validateFacts } from "./schema.js";

const DEFAULT_DEPTH = 3;

interface CliArgs {
  root: string;
  depth: number;
}

function parseArgs(argv: string[]): CliArgs {
  let root: string | undefined;
  let depth: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--depth") {
      const value = argv[++i];
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`--depth expects a non-negative integer, got: ${value ?? "(missing)"}`);
      }
      depth = n;
    } else if (arg.startsWith("--depth=")) {
      const value = arg.slice("--depth=".length);
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`--depth expects a non-negative integer, got: ${value}`);
      }
      depth = n;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    } else if (root === undefined) {
      root = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (root === undefined) {
    throw new Error("missing required <root> argument");
  }

  if (depth === undefined) {
    const envDepth = process.env.TRACE_DEPTH;
    const parsed = envDepth !== undefined ? Number(envDepth) : NaN;
    depth = Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_DEPTH;
  }

  return { root, depth };
}

function printUsage(): void {
  process.stderr.write(
    [
      "codebase-endpoint-explainer",
      "",
      "Usage: cee <root> [--depth N]",
      "",
      "  <root>        directory to analyze",
      "  --depth N     bounded call-graph trace depth (default 3, or TRACE_DEPTH)",
      "  -h, --help    show this help",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    printUsage();
    process.exit(2);
  }

  const facts = await dispatch(args.root, { depth: args.depth });
  const validated = validateFacts(facts);
  process.stdout.write(`${JSON.stringify(validated, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`cee: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
