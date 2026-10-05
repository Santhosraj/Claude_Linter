import { describe, expect, it } from "vitest";

import { looksDirective, scanMarkdown, toRules } from "../src/parse/markdown.js";

/**
 * Which blocks become rules.
 *
 * The filter used to admit only blocks containing one of twenty hint words, on
 * the theory that "a false negative costs us one missed duplicate". Measured on
 * 11 real CLAUDE.md files it rejected 70% of blocks — 94–100% in five of them,
 * one of which produced no rules at all — and a rejected block is invisible to
 * every memory check, not just one. The commonest casualty was the plainest
 * instruction there is: an imperative with no hint word in it.
 */
describe("looksDirective admits instructions written as plain imperatives", () => {
  // Every one of these was silently discarded before.
  it.each([
    "Keep every function under 20 lines.",
    "Store all timestamps in UTC.",
    "Pin direct dependencies to exact versions.",
    "Log every payment failure with its request id.",
    "Commit both the .tmpl and generated .md files",
    "Squash-merge pull requests into main.",
    "Re-evaluate the bump level against the diff.",
    "Be direct about quality.",
    "Note the original PR number and head branch name.",
  ])("%s", (text) => {
    expect(looksDirective(text)).toBe(true);
  });

  it("admits a prohibition phrased as 'No ...'", () => {
    expect(looksDirective("No jargon in the release summary.")).toBe(true);
    expect(looksDirective("No edits to ETHOS.md from external contributors.")).toBe(true);
  });

  it("finds the instruction after a condition, a dash, an arrow, or a label", () => {
    expect(looksDirective("When merging main brings a higher VERSION, re-evaluate the bump.")).toBe(true);
    expect(looksDirective("Redundant return await — remove it when there is no try block.")).toBe(true);
    expect(looksDirective("Bugs/errors → invoke /investigate")).toBe(true);
    expect(looksDirective("Workflow: push the branch to the base repo.")).toBe(true);
    expect(looksDirective("Is the version already released? (If yes, bump the version.)")).toBe(true);
  });

  it("still admits everything the hint words admitted", () => {
    expect(looksDirective("Always use tabs for indentation.")).toBe(true);
    expect(looksDirective("Prefer pnpm.")).toBe(true);
  });
});

describe("looksDirective still rejects description", () => {
  it.each([
    "Express + SQLite task API. Node 20+. CommonJS.",
    "Auth is a signed token, checked by the auth middleware.",
    "Per-device salt: ~/.gstack/security/device-salt",
    "Rules:",
    "What branch am I on?",
  ])("%s", (text) => {
    expect(looksDirective(text)).toBe(false);
  });

  it("reads a verb-shaped first word followed by a copula as a noun", () => {
    // "Build", "Test" and "Log" are verbs and nouns. The copula decides.
    expect(looksDirective("Build output is written to dist/.")).toBe(false);
    expect(looksDirective("Test fixtures are recorded against the real binary.")).toBe(false);
    expect(looksDirective("Log files have a seven day retention.")).toBe(false);
  });

  it("treats an all-caps first word as a constant, not an instruction", () => {
    // `warn` is in the verb list; `WARN:` opening a threshold table is not one.
    expect(looksDirective("WARN: 0.75 — cross-confirm threshold.")).toBe(false);
  });

  it("does not split a comma-separated list of nouns into fake clauses", () => {
    // Splitting on every comma would read "merge" as a verb here.
    expect(looksDirective("Branch resyncs, merge commits with main, rebase activity.")).toBe(false);
  });
});

describe("the scanner drops document structure", () => {
  const texts = (md: string) => scanMarkdown(md).blocks.map((b) => b.text);

  it("does not turn a thematic break into a paragraph", () => {
    expect(texts(["Always run the tests.", "", "---", "", "Prefer pnpm."].join("\n"))).toEqual([
      "Always run the tests.",
      "Prefer pnpm.",
    ]);
  });

  it("does not glue a table row onto neighbouring prose", () => {
    // Previously one paragraph, so a cell saying "use" made the table a rule.
    const md = ["| Task | Use |", "|---|---|", "| build | make |", "Always run the tests."].join("\n");
    expect(texts(md)).toEqual(["Always run the tests."]);
  });

  it("skips HTML comments, single- and multi-line", () => {
    const md = [
      "<!-- generated:start -->",
      "<!--",
      "  Always use tabs.",
      "-->",
      "Prefer pnpm.",
    ].join("\n");
    expect(texts(md)).toEqual(["Prefer pnpm."]);
  });

  it("keeps a rule with a trailing comment, minus the comment", () => {
    expect(texts("- Always use tabs <!-- legacy -->")).toEqual(["Always use tabs"]);
  });

  it("keeps a comment that the rule shows as an example in a code span", () => {
    expect(texts("- Wrap generated sections in `<!-- gen:start -->` markers.")).toEqual([
      "Wrap generated sections in <!-- gen:start --> markers.",
    ]);
  });

  it("skips YAML frontmatter, which read as a paragraph of rules", () => {
    const md = ["---", "name: payments", "description: Use this for billing work", "---", "", "- Keep amounts in cents."].join("\n");
    expect(texts(md)).toEqual(["Keep amounts in cents."]);
  });

  it("treats an unclosed leading --- as a plain separator", () => {
    expect(texts(["---", "Always run the tests."].join("\n"))).toEqual(["Always run the tests."]);
  });
});

describe("toRules end to end", () => {
  it("turns an imperative-only CLAUDE.md into rules instead of nothing", () => {
    // Shaped like the real file that previously yielded zero rules.
    const md = [
      "# Setup",
      "",
      "- Create the Next.js app with the app router.",
      "- Configure the OCI client from environment variables.",
      "- Store extracted text alongside each upload.",
      "- Implement status tracking for every analysis.",
    ].join("\n");
    expect(toRules(scanMarkdown(md), "/p/CLAUDE.md", "project")).toHaveLength(4);
  });
});
