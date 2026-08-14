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
  it("states the conformance ratio correctly", () => {
    const proven = MERGE_RULES.filter((r) => r.confidence === "conformance").length;
    expect(readme).toContain(`**${proven} of ${MERGE_RULES.length}** rules is conformance-tier`);
  });

  it("does not promise install commands that cannot resolve", () => {
    // `npx <name>` resolves a PACKAGE name, not a bin name. Every npx command
    // here must therefore name something that actually resolves — the README once
    // opened with `npx cclint` while no such package existed, which was an E404
    // for every new reader.
    //
    // Two kinds resolve, and the distinction is the point: a package we publish,
    // or a devDependency of this repo, which is what `npx tsx src/cli.ts` relies
    // on for the run-from-a-clone instructions. Allowing only the former made
    // this fail on a correct command; allowing anything would stop catching the
    // E404 it exists for. Reading devDependencies keeps it self-maintaining —
    // drop tsx from the manifest and the docs that use it start failing.
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };

    // `cclint` is the published name, and the only one. The core used to be
    // `claude-config-lint` with `cclint` as a thin alias; that name belongs to an
    // unrelated project on npm and was never available here.
    const resolvable = new Set(["cclint", ...Object.keys(pkg.devDependencies ?? {})]);

    const invoked = [...readme.matchAll(/npx\s+(?:-p\s+\S+\s+)?([a-z0-9@/._-]+)/gi)].map(
      (m) => m[1]!,
    );
    expect(invoked.length).toBeGreaterThan(0);
    expect(
      invoked.filter((name) => !resolvable.has(name)),
      "these npx commands name nothing that resolves",
    ).toEqual([]);
  });
});
