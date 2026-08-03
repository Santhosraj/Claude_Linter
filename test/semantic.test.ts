import { describe, expect, it } from "vitest";

import { BUILTIN_AXES, classify } from "../src/rules/axes.js";
import { buildCandidatePairs, significantTerms } from "../src/semantic/prefilter.js";
import { SemanticAdjudicator } from "../src/semantic/adjudicate.js";
import { normalizeRule } from "../src/parse/markdown.js";
import type { MemoryRule } from "../src/model/types.js";

function rule(
  text: string,
  file: string,
  line: number,
  headings: string[] = [],
): MemoryRule {
  return {
    text,
    normalized: normalizeRule(text),
    file,
    layer: "project",
    position: { line, column: 1 },
    headings,
  };
}

describe("prefilter", () => {
  it("surfaces rules that share a known decision axis", () => {
    const rules = [
      rule("Always use tabs for indentation.", "/p/CLAUDE.md", 3),
      rule("Use 2-space indentation for all source files.", "/p/docs/style.md", 5),
    ];
    const pairs = buildCandidatePairs(rules, { axes: BUILTIN_AXES });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.reason).toContain("indentation");
  });

  it("pairs on a shared axis even when the rules share NO vocabulary", () => {
    // Regression guard. The axis signal used to be reachable only for pairs
    // that had already been surfaced by the term index, so two rules picking
    // opposite sides of the same decision in different words were silently
    // never considered. Note these two share zero significant terms — that is
    // the whole point of the fixture, so do not "improve" the wording.
    const rules = [
      rule("Always use tabs.", "/p/CLAUDE.md", 3),
      rule("Use 2-space indentation.", "/p/docs/style.md", 5),
    ];

    const terms = [
      significantTerms(rules[0]!.normalized),
      significantTerms(rules[1]!.normalized),
    ];
    const overlap = [...terms[0]!].filter((t) => terms[1]!.has(t));
    expect(overlap).toEqual([]);

    const pairs = buildCandidatePairs(rules, { axes: BUILTIN_AXES });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.reason).toContain("indentation");
  });

  it("does not pair two bullets under the same heading in the same file", () => {
    // "Use tabs, never spaces" split across two bullets is ONE instruction.
    // Pairing them would send the model a guaranteed false positive.
    const rules = [
      rule("Always use tabs for indentation.", "/p/CLAUDE.md", 3, ["Style"]),
      rule("Never use spaces for indentation.", "/p/CLAUDE.md", 4, ["Style"]),
    ];
    expect(buildCandidatePairs(rules, { axes: BUILTIN_AXES })).toEqual([]);
  });

  it("does not pair identical rules — those are duplicates, not conflicts", () => {
    const rules = [
      rule("Always run the test suite before committing.", "/p/CLAUDE.md", 3),
      rule("Always run the test suite before committing.", "/h/CLAUDE.md", 9),
    ];
    expect(buildCandidatePairs(rules, { axes: BUILTIN_AXES })).toEqual([]);
  });

  it("ignores rules with no topical overlap", () => {
    const rules = [
      rule("Always use tabs for indentation.", "/p/CLAUDE.md", 3),
      rule("Deploy to staging before production.", "/p/docs/ops.md", 2),
    ];
    expect(buildCandidatePairs(rules, { axes: BUILTIN_AXES })).toEqual([]);
  });

  it("pairs rules sharing enough significant vocabulary", () => {
    const rules = [
      rule("Write integration tests for every database migration.", "/p/CLAUDE.md", 3),
      rule("Skip integration tests for a database migration when time is short.", "/p/docs/x.md", 8),
    ];
    const pairs = buildCandidatePairs(rules, { axes: BUILTIN_AXES });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.reason).toContain("share the terms");
  });

  it("respects the pair cap so a large repo cannot fan out unbounded", () => {
    const rules = Array.from({ length: 40 }, (_, i) =>
      rule(`Prefer pnpm over yarn for workspace ${i} dependency installs.`, `/p/f${i}.md`, 1),
    );
    const pairs = buildCandidatePairs(rules, { axes: BUILTIN_AXES, maxPairs: 5 });
    expect(pairs.length).toBeLessThanOrEqual(5);
  });

  it("produces a stable order across runs", () => {
    const rules = [
      rule("Always use tabs for indentation.", "/p/a.md", 3),
      rule("Use 2-space indentation everywhere.", "/p/b.md", 4),
      rule("Prefer spaces over tabs in Python.", "/p/c.md", 5),
    ];
    const first = buildCandidatePairs(rules, { axes: BUILTIN_AXES });
    const second = buildCandidatePairs(rules, { axes: BUILTIN_AXES });
    expect(first.map((p) => `${p.a.file}->${p.b.file}`)).toEqual(
      second.map((p) => `${p.a.file}->${p.b.file}`),
    );
  });

  it("stems terms so singular and plural forms match", () => {
    expect(significantTerms("write comments carefully")).toContain("comment");
    expect(significantTerms("write comment carefully")).toContain("comment");
  });
});

describe("axis classification", () => {
  it("picks a single side when a rule commits to one", () => {
    expect(classify("Always use tabs for indentation.")[0]?.side.name).toBe("tabs");
    expect(classify("Use 2-space indentation.")[0]?.side.name).toBe("spaces");
  });

  it("abstains when a rule mentions both sides", () => {
    // "tabs, not spaces" is one decision. Reporting it as self-conflicting
    // would be the archetypal heuristic false positive.
    expect(classify("Use tabs, never spaces.")).toEqual([]);
  });
});

describe("adjudicator degradation", () => {
  it("reports why it could not run instead of failing the lint", async () => {
    const adjudicator = new SemanticAdjudicator({
      apiKey: undefined,
      projectRoot: "/p",
      // Point the cache somewhere harmless for this assertion.
      cacheDir: "/tmp/cclint-test-cache",
    });
    const rules = [
      rule("Always use tabs.", "/p/a.md", 1),
      rule("Use 2-space indentation.", "/p/b.md", 1),
    ];
    const pairs = buildCandidatePairs(rules, { axes: BUILTIN_AXES });
    const diagnostics = await adjudicator.run(pairs);

    expect(diagnostics).toEqual([]);
    expect(adjudicator.unavailableReason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("warns rather than silently truncating when the pair cap bites", async () => {
    const adjudicator = new SemanticAdjudicator({
      apiKey: undefined,
      projectRoot: "/p",
      maxPairs: 1,
      cacheDir: "/tmp/cclint-test-cache",
    });
    const rules = [
      rule("Always use tabs.", "/p/a.md", 1),
      rule("Use 2-space indentation.", "/p/b.md", 1),
      rule("Prefer spaces in Python files.", "/p/c.md", 1),
    ];
    const pairs = buildCandidatePairs(rules, { axes: BUILTIN_AXES });
    expect(pairs.length).toBeGreaterThan(1);

    const diagnostics = await adjudicator.run(pairs);
    expect(diagnostics.some((d) => d.ruleId === "semantic/truncated")).toBe(true);
  });
});
