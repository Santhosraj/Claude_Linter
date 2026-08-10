import { describe, expect, it } from "vitest";

import { scanMarkdown, toRules } from "../src/parse/markdown.js";

/**
 * The CLAUDE.md scanner.
 *
 * Everything downstream — duplicate detection, axis classification, the
 * semantic judge — reads the text this produces. A rule split at a physical
 * newline is a sentence fragment, and no amount of care further down recovers
 * from it, so the wrapping cases below are load-bearing.
 */

const text = (md: string) => scanMarkdown(md).blocks.map((b) => b.text);

describe("wrapped list items", () => {
  it("joins continuation lines into the bullet that owns them", () => {
    // Regression guard, found on a real 141-rule CLAUDE.md where 34 rules were
    // fragments. The bullet below used to emit a truncated list item ending at
    // "to pass" plus a separate headless paragraph starting at "state between",
    // and the semantic judge duly reported that a rule was "cut off
    // mid-sentence".
    const blocks = scanMarkdown(
      [
        "- **Use natural language for logic and state.** Don't use shell variables to pass",
        "  state between code blocks. Instead, tell Claude what to remember and reference",
        '  it in prose (e.g., "the base branch detected in Step 0").',
      ].join("\n"),
    ).blocks;

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("listItem");
    expect(blocks[0]?.text).toBe(
      "Use natural language for logic and state. Don't use shell variables to pass " +
        "state between code blocks. Instead, tell Claude what to remember and reference " +
        'it in prose (e.g., "the base branch detected in Step 0").',
    );
  });

  it("reports the span of a wrapped bullet, not just its first line", () => {
    const block = scanMarkdown(["- Always run the suite", "  before opening a PR."].join("\n"))
      .blocks[0];
    expect(block?.position.line).toBe(1);
    expect(block?.position.endLine).toBe(2);
  });

  it("keeps a nested bullet as its own rule", () => {
    // Indented, but a list item in its own right — absorbing it would merge two
    // independent instructions into one.
    expect(
      text(["- Prefer pnpm for installs.", "  - Never commit the lockfile by hand."].join("\n")),
    ).toEqual(["Prefer pnpm for installs.", "Never commit the lockfile by hand."]);
  });

  it("stops the bullet at a blank line", () => {
    expect(
      text(["- Prefer pnpm for installs.", "", "  Always vendor the registry mirror."].join("\n")),
    ).toEqual(["Prefer pnpm for installs.", "Always vendor the registry mirror."]);
  });

  it("does not treat an unindented following line as a continuation", () => {
    // Lazy continuation is legal CommonMark, but here it is indistinguishable
    // from a new paragraph, and swallowing a paragraph is the worse error.
    expect(
      text(["- Prefer pnpm for installs.", "Always vendor the registry mirror."].join("\n")),
    ).toEqual(["Prefer pnpm for installs.", "Always vendor the registry mirror."]);
  });

  it("does not absorb a fenced example, or the prose after it", () => {
    expect(
      text(
        [
          "- Always run the formatter:",
          "  ```bash",
          "  npm run fmt --write",
          "  ```",
          "  Never commit unformatted code.",
        ].join("\n"),
      ),
    ).toEqual(["Always run the formatter:", "Never commit unformatted code."]);
  });

  it("ends the bullet at a heading", () => {
    expect(text(["- Prefer pnpm.", "## Style", "Always use tabs."].join("\n"))).toEqual([
      "Prefer pnpm.",
      "Always use tabs.",
    ]);
  });

  it("carries the merged text through to rules", () => {
    const md = ["## Style", "- Always use tabs, never", "  spaces, in Go files."].join("\n");
    const rules = toRules(scanMarkdown(md), "/p/CLAUDE.md", "project");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.text).toBe("Always use tabs, never spaces, in Go files.");
    expect(rules[0]?.headings).toEqual(["Style"]);
  });
});
