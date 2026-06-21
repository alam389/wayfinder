/**
 * Built-in adapter registration.
 *
 * Adapters are registered explicitly (not via import side effects) so callers
 * control when the global registry is populated, and tests can opt in. Idempotent:
 * safe to call from both the CLI and individual test files.
 */
import { adapters, registerAdapter } from "../registry.js";
import { fastapiAdapter } from "./python/fastapi.js";
import { expressAdapter } from "./ts/express.js";
import { nestAdapter } from "./ts/nest.js";

const BUILTIN = [expressAdapter, nestAdapter, fastapiAdapter];

export function registerBuiltinAdapters(): void {
  for (const adapter of BUILTIN) {
    if (!adapters.includes(adapter)) registerAdapter(adapter);
  }
}
