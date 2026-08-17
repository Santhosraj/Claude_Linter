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

  it("pairs contradictory bullets under one heading, ranked after cross-section pairs", () => {
    /**
     * Same-heading pairs used to be dropped outright, as "almost always one
     * coherent instruction". Measured against a CLAUDE.md whose rules were
     * grouped under headings — the normal way to write one — that produced ZERO
     * candidate pairs, so `--semantic` sent nothing to the model and reported a
     * clean run. An inert paid feature is worse than a noisy one.
     *
     * They are now demoted rather than dropped: judged only after every
     * cross-section pair. The genuinely-agreeing case the old skip protected
     * against ("Always use tabs" + "Never use spaces") is handled upstream now,
     * by classify() declining to read a rejection as a choice.
     */
    const crossSection = [
      rule("Always indent with tabs, never spaces.", "/p/CLAUDE.md", 3, ["A"]),
      rule("Every file must be indented with two spaces.", "/p/CLAUDE.md", 9, ["B"]),
    ];
    const sameSection = [
      rule("Always indent with tabs, never spaces.", "/p/CLAUDE.md", 3, ["Style"]),
      rule("Every file must be indented with two spaces.", "/p/CLAUDE.md", 4, ["Style"]),
    ];

    expect(buildCandidatePairs(sameSection, { axes: BUILTIN_AXES })).toHaveLength(1);

    // ...and the cross-section pair outranks the co-located one when both exist.
    const mixed = [...crossSection, ...sameSection];
    const pairs = buildCandidatePairs(mixed, { axes: BUILTIN_AXES });
    expect(pairs.length).toBeGreaterThan(0);
    const first = pairs[0]!;
    const firstIsCrossSection = first.a.headings.join("/") !== first.b.headings.join("/");
    expect(firstIsCrossSection).toBe(true);
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

  it("does not let one wordy rule monopolise the pair budget", () => {
    // Measured on a real 144-rule CLAUDE.md: one long paragraph appeared in 23
    // of 40 candidate pairs and a second in 17 — 57% of the budget spent on a
    // single rule, while 142 rules were never compared to each other. Long text
    // shares vocabulary with everything, so without a per-rule cap the ranking
    // is dominated by length rather than by likelihood of conflict.
    const magnet = rule(
      "Prefer " +
        Array.from({ length: 20 }, (_, i) => `wibble${i} over wobble${i}`).join(", ") +
        ".",
      "/p/CLAUDE.md",
      1,
    );
    const topics = Array.from({ length: 20 }, (_, i) =>
      rule(`Prefer wibble${i} over wobble${i}.`, `/p/t${i}.md`, 1),
    );

    const pairs = buildCandidatePairs([magnet, ...topics], {
      axes: BUILTIN_AXES,
      maxPairs: 10,
      maxPairsPerRule: 3,
    });

    const touchingMagnet = pairs.filter(
      (p) => p.a.file === "/p/CLAUDE.md" || p.b.file === "/p/CLAUDE.md",
    );
    expect(touchingMagnet.length).toBeLessThanOrEqual(3);
    // Non-vacuity: it is the per-rule cap, not the pair cap, that bounded this.
    // Every available pair involves the magnet, so an uncapped run returns 10 —
    // verified by mutation.
    expect(pairs.length).toBeGreaterThan(0);
  });

  it("ranks an axis match above incidental vocabulary overlap", () => {
    // Budget is scarce, so the strongest signal must be spent first. Two rules
    // landing on opposite sides of a known decision axis are far likelier to
    // conflict than two rules that happen to share a few words.
    const rules = [
      rule("Always use tabs for indentation.", "/p/a.md", 1),
      rule("Use 2-space indentation everywhere.", "/p/b.md", 1),
      ...Array.from({ length: 6 }, (_, i) =>
        rule(`Run the migration checker before every deploy ${i}.`, `/p/m${i}.md`, 1),
      ),
    ];

    const pairs = buildCandidatePairs(rules, { axes: BUILTIN_AXES, maxPairs: 1 });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.reason).toContain("decision axis");
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

  it("resolves a rule that names both sides to the one it is choosing", () => {
    /**
     * This used to abstain, on the reasoning that reporting "tabs, never spaces"
     * as self-conflicting would be the archetypal false positive. The fear was
     * misplaced: classifying a rule is not the same as conflicting it with
     * itself — `memory/axis-conflict` only pairs DISTINCT rules and skips pairs
     * whose sides agree, so nothing here can self-conflict.
     *
     * Abstaining had a real cost. `X, never Y` is one of the most natural ways
     * to state a preference, so the clearest possible statement of a choice was
     * invisible to conflict detection, while the vaguer "Use tabs" classified
     * fine. Verified against a real project fixture: adding ", never spaces"
     * made an otherwise-detected conflict disappear.
     */
    expect(classify("Use tabs, never spaces.")[0]?.side.name).toBe("tabs");
    expect(classify("Prefer spaces rather than tabs.")[0]?.side.name).toBe("spaces");
  });

  it("leaves a lone rejection unclassified rather than inferring the opposite", () => {
    // "Never use spaces" rejects one side and picks none. Reading it as a vote
    // FOR spaces made it a false conflict against a neighbouring "Always use
    // tabs" — two rules that plainly agree. Inferring "therefore tabs" would
    // work on a two-sided axis and break on package managers, which have four.
    expect(classify("Never use spaces for indentation.")).toEqual([]);
    expect(classify("Avoid tabs.")).toEqual([]);
  });

  it("is not confused by a negation elsewhere in the rule", () => {
    // The old `tabs` pattern carried `(?!.*\bnot\b)`, so any later "not"
    // suppressed the match entirely and the rule expressed no opinion.
    expect(classify("Use tabs; do not commit generated files.")[0]?.side.name).toBe("tabs");
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
