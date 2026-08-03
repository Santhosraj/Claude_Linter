import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { MERGE_RULES, ruleFor } from "../src/model/merge-semantics.js";

const fixturesRoot = resolve(__dirname, "fixtures");

/**
 * Meta-tests on the table itself.
 *
 * The `permissions` bug — a nested rule with no container entry, so the
 * resolver never descended and silently replaced a list it should have unioned
 * — is exactly the class of mistake that produces confidently-wrong output.
 * These tests make that class of mistake impossible to reintroduce.
 */
describe("merge-semantics table integrity", () => {
  it("every nested rule has a deep-merging container ancestor", () => {
    const paths = new Set(MERGE_RULES.map((r) => r.path));
    const missing: string[] = [];

    for (const rule of MERGE_RULES) {
      const segs = rule.path.split(".");
      for (let i = 1; i < segs.length; i++) {
        const ancestor = segs.slice(0, i).join(".");
        if (!paths.has(ancestor)) {
          missing.push(`${rule.path} needs a container entry for "${ancestor}"`);
          continue;
        }
        const ancestorRule = MERGE_RULES.find((r) => r.path === ancestor)!;
        if (ancestorRule.strategy !== "deepMerge" && ancestorRule.strategy !== "hooks") {
          missing.push(
            `${rule.path} is unreachable: container "${ancestor}" uses ` +
              `"${ancestorRule.strategy}", which never descends into children`,
          );
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("has no duplicate paths", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const r of MERGE_RULES) {
      if (seen.has(r.path)) dupes.push(r.path);
      seen.add(r.path);
    }
    expect(dupes).toEqual([]);
  });

  it("resolves the most specific matching rule", () => {
    expect(ruleFor("permissions.allow").strategy).toBe("concat");
    expect(ruleFor("permissions.defaultMode").strategy).toBe("override");
    expect(ruleFor("permissions").strategy).toBe("deepMerge");
  });

  it("falls back to override for unknown keys rather than guessing additive", () => {
    // Guessing "additive" for an unknown key would under-report dead config;
    // guessing "override" over-reports at worst, which is the safer failure.
    const rule = ruleFor("someFutureKeyWeHaveNeverSeen");
    expect(rule.strategy).toBe("override");
    expect(rule.confidence).toBe("assumed");
  });

  it("treats hooks as additive at the event level", () => {
    expect(ruleFor("hooks").strategy).toBe("hooks");
    expect(ruleFor("hooks.PreToolUse").strategy).toBe("hooks");
  });
});

/**
 * Anti-gaming guard.
 *
 * `cclint doctor` advertises how many merge rules are proven against the real
 * binary. That number is only meaningful if a rule cannot be promoted to
 * `conformance` by editing a string. Every such rule must name fixtures, and
 * those fixtures must exist and carry an actual recording.
 */
describe("conformance claims are backed by real fixtures", () => {
  const claimed = MERGE_RULES.filter((r) => r.confidence === "conformance");

  it("every conformance-tier rule names its proving fixtures", () => {
    const unbacked = claimed
      .filter((r) => !r.provenance || r.provenance.length === 0)
      .map((r) => r.path);
    expect(unbacked).toEqual([]);
  });

  it("every named fixture exists and has a recording", () => {
    const missing: string[] = [];
    for (const rule of claimed) {
      for (const fixture of rule.provenance ?? []) {
        const dir = join(fixturesRoot, fixture);
        if (!existsSync(dir)) {
          missing.push(`${rule.path} → fixture "${fixture}" does not exist`);
          continue;
        }
        if (!existsSync(join(dir, ".conformance"))) {
          missing.push(`${rule.path} → fixture "${fixture}" has no .conformance recording`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("only rules with provenance may carry the conformance label", () => {
    const mislabelled = MERGE_RULES.filter(
      (r) => r.confidence !== "conformance" && (r.provenance?.length ?? 0) > 0,
    ).map((r) => r.path);
    expect(mislabelled).toEqual([]);
  });
});
