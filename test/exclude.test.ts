import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { analyze, globToRegExp } from "../src/analyze.js";

const fixture = resolve(__dirname, "fixtures", "sample-project");

describe("globToRegExp", () => {
  it("matches within a segment with a single star", () => {
    expect(globToRegExp("docs/*.md").test("docs/a.md")).toBe(true);
    // A single star must not cross a separator.
    expect(globToRegExp("docs/*.md").test("docs/nested/a.md")).toBe(false);
  });

  it("crosses segments with a double star", () => {
    const p = globToRegExp("test/fixtures/**");
    expect(p.test("test/fixtures/x/CLAUDE.md")).toBe(true);
    expect(p.test("test/fixtures/CLAUDE.md")).toBe(true);
    expect(p.test("test/other/CLAUDE.md")).toBe(false);
  });

  it("matches zero intermediate segments for a mid-pattern double star", () => {
    const p = globToRegExp("a/**/b.md");
    expect(p.test("a/b.md")).toBe(true);
    expect(p.test("a/x/b.md")).toBe(true);
    expect(p.test("a/x/y/b.md")).toBe(true);
    expect(p.test("c/b.md")).toBe(false);
  });

  it("treats dots literally rather than as regex wildcards", () => {
    expect(globToRegExp("a.md").test("axmd")).toBe(false);
    expect(globToRegExp("a.md").test("a.md")).toBe(true);
  });

  it("is anchored, so a partial match does not exclude", () => {
    expect(globToRegExp("docs").test("docs/a.md")).toBe(false);
  });
});

describe("excludePaths removes files from discovery entirely", () => {
  const project = resolve(__dirname, "fixtures", "exclude-project");
  const options = {
    cwd: project,
    home: join(project, ".fake-home"),
    managedPolicyPath: join(project, "__no_such_policy__.json"),
  };

  const rel = (file: string) =>
    file.slice(project.length + 1).split("\\").join("/");

  it("drops excluded files and keeps everything else", async () => {
    const result = await analyze({ ...options, skipBudget: true });
    const files = result.context.memory.map((m) => rel(m.file)).sort();

    expect(files).toContain("CLAUDE.md");
    expect(files).toContain("kept/CLAUDE.md");
    expect(files).not.toContain("ignored/CLAUDE.md");
  });

  it("reports no findings from an excluded file", async () => {
    const result = await analyze({ ...options, strict: true, skipBudget: true });

    const fromIgnored = result.diagnostics.filter((d) => rel(d.file).startsWith("ignored/"));
    expect(fromIgnored).toEqual([]);

    // Non-vacuous: the equivalent defect in a kept file IS reported, so the
    // assertion above is about exclusion rather than about the rule being off.
    const fromKept = result.diagnostics.filter(
      (d) => d.ruleId === "memory/dead-import" && rel(d.file) === "kept/CLAUDE.md",
    );
    expect(fromKept.length).toBe(1);
  });

  it("excludes the file from the token budget too, not just from the rules", async () => {
    const result = await analyze(options);
    const budgeted = (result.budget?.entries ?? []).map((e) => rel(e.file));

    expect(budgeted.some((f) => f.startsWith("ignored/"))).toBe(false);
    expect(budgeted.some((f) => f.startsWith("kept/"))).toBe(true);
  });
});

describe("baseline behaviour without an exclude", () => {
  it("still analyses a nested CLAUDE.md when nothing is excluded", async () => {
    const result = await analyze({
      cwd: fixture,
      home: join(fixture, ".fake-home"),
      managedPolicyPath: join(fixture, "__no_such_policy__.json"),
      skipBudget: true,
    });
    expect(result.context.memory.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((d) => d.ruleId === "memory/dead-import")).toBe(true);
  });
});
