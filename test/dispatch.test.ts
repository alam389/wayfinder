import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, IGNORE_DIRS } from "../src/registry.js";
import { validateFacts } from "../src/schema.js";

describe("Phase 1: scaffold + schema + empty CLI", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cee-"));
    // A normal source file plus files buried inside ignore-listed dirs.
    await fs.writeFile(path.join(tmp, "app.ts"), "export const x = 1;\n");
    for (const dir of IGNORE_DIRS) {
      const d = path.join(tmp, dir);
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, "buried.ts"), "throw new Error('should be skipped');\n");
    }
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("emits empty-but-valid Facts with no adapters registered", async () => {
    const facts = await dispatch(tmp);
    expect(facts.schema_version).toBe("1.0");
    expect(facts.endpoints).toEqual([]);
    expect(facts.endpoint_count).toBe(0);
    expect(facts.languages_detected).toEqual([]);
    expect(() => validateFacts(facts)).not.toThrow();
  });

  it("resolves root to an absolute path", async () => {
    const facts = await dispatch(tmp);
    expect(path.isAbsolute(facts.root)).toBe(true);
  });

  it("does not crash when ignore-listed dirs contain files (walker skips them)", async () => {
    // With no adapters, output is empty regardless, but this proves walking the
    // ignore-listed subtrees does not throw or hang.
    const facts = await dispatch(tmp);
    expect(facts.warnings).toEqual([]);
  });
});
