import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MERGE_RULES } from "../src/model/merge-semantics.js";

/**
 * The README's claims about the code.
 *
 * Documentation drift is not cosmetic for this tool specifically: the pitch is
 * "we tell you the truth about your config", so a README that contradicts
 * `cclint doctor` undermines the only thing being sold. Two such claims had
 * already rotted before this test existed — an oracle count that said three
 * when four were implemented, and a conformance ratio of 1-of-28 against a real
 * 1-of-32 — and both were the kind of number a reader checks.
 */

const readme = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"),
  "utf8",
);

describe("README", () => {
  it("documents every key in the merge table", () => {
    const missing = MERGE_RULES.map((r) => r.path).filter(
      (path) => !readme.includes(`\`${path}\``),
    );
    expect(missing).toEqual([]);
  });

  it("states the merge-table size correctly", () => {
    // `cclint doctor` prints this same denominator; if they disagree, one of
    // them is lying to the user.
    expect(readme).toContain(`The 32 keys cclint knows the merge rule for`);
    expect(MERGE_RULES).toHaveLength(32);
  });

  it("states the conformance ratio correctly", () => {
    const proven = MERGE_RULES.filter((r) => r.confidence === "conformance").length;
    expect(readme).toContain(`**${proven} of ${MERGE_RULES.length}** rules is conformance-tier`);
  });

  it("does not promise install commands that cannot resolve", () => {
    // `npx <name>` resolves a PACKAGE name, not a bin name. Every npx command
    // here must therefore name a package we actually publish — the README once
    // opened with `npx cclint` while no such package existed, which was an E404
    // for every new reader.
    const published = new Set(["claude-config-lint", "cclint"]);
    const invoked = [...readme.matchAll(/npx\s+(?:-p\s+\S+\s+)?([a-z0-9@/._-]+)/gi)].map(
      (m) => m[1]!,
    );
    expect(invoked.length).toBeGreaterThan(0);
    expect(invoked.filter((name) => !published.has(name))).toEqual([]);
  });
});
