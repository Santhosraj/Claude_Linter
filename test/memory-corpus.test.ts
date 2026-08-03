import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/analyze.js";

const fixture = resolve(__dirname, "fixtures", "sample-project");

const options = {
  cwd: fixture,
  home: join(fixture, ".fake-home"),
  managedPolicyPath: join(fixture, "__no_such_policy__.json"),
  skipBudget: true,
};

/**
 * Regression guard for the imported-memory gap.
 *
 * `@import`ed files are in context every turn, exactly like the CLAUDE.md that
 * imported them. For a while the analyzer followed imports only when counting
 * tokens, so every rule living in an imported file was invisible to the rule
 * engine — duplicates and conflicts in those files could never be reported. The
 * symptom was subtle: the tool ran clean and looked like it had checked
 * everything.
 */
describe("memory corpus includes imported files", () => {
  it("scans @imported files, not just the top-level CLAUDE.md", async () => {
    const result = await analyze(options);
    const files = result.context.memory.map((m) => resolve(m.file));

    expect(files).toContain(resolve(fixture, "docs", "conventions.md"));
  });

  it("tags imported files with the `import` layer", async () => {
    const result = await analyze(options);
    const imported = result.context.memory.find(
      (m) => resolve(m.file) === resolve(fixture, "docs", "conventions.md"),
    );

    expect(imported?.layer).toBe("import");
  });

  it("extracts rules from imported files so they can conflict", async () => {
    const result = await analyze(options);
    const imported = result.context.memory.find(
      (m) => resolve(m.file) === resolve(fixture, "docs", "conventions.md"),
    );

    // An empty rule list here means the file was discovered but never scanned —
    // the gap would be half-fixed and still silent.
    expect(imported?.rules.length).toBeGreaterThan(0);
  });

  it("reports a conflict between an imported rule and the importing file", async () => {
    const result = await analyze({ ...options, strict: true });

    const conflict = result.diagnostics.find(
      (d) =>
        d.ruleId === "memory/axis-conflict" &&
        d.detail?.some((line) => line.includes("conventions.md")),
    );

    expect(conflict, "expected the tabs-vs-2-space conflict across the import boundary").toBeDefined();
  });

  it("does not double-count a file reachable by more than one path", async () => {
    const result = await analyze(options);
    const files = result.context.memory.map((m) => resolve(m.file));

    expect(new Set(files).size).toBe(files.length);
  });
});

/**
 * The scanner must treat fenced code blocks as inert. The fixture's CLAUDE.md
 * contains `- Always use spaces, never tabs` inside a ```bash fence; treating
 * that as a rule would invent a conflict that does not exist.
 */
describe("fenced code is not instruction", () => {
  it("ignores directive-looking lines inside code fences", async () => {
    const result = await analyze(options);
    const projectMemory = result.context.memory.find(
      (m) => resolve(m.file) === resolve(fixture, "CLAUDE.md"),
    );

    const fenced = projectMemory?.rules.filter((r) =>
      r.normalized.includes("always use spaces never tabs"),
    );
    expect(fenced).toEqual([]);
  });
});
