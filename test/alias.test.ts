import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The `cclint` alias package.
 *
 * It exists because npx resolves a package name, not a bin name — without it
 * the `npx cclint` in our own README is an E404. Since it is a second published
 * artifact that must move in lockstep with the core, the ways it can rot
 * silently are pinned here rather than left to release-day discipline.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const json = (p: string) => JSON.parse(read(p)) as Record<string, any>;

const core = json("package.json");
const alias = json("alias/package.json");

describe("cclint alias package", () => {
  it("pins the exact core version it wraps", () => {
    // A range would let `npx cclint` drift onto a core it was never tested
    // against; a stale exact pin is the same bug in the other direction. Run
    // `npm run sync:alias` — it is the only thing that should write this.
    expect(alias.version).toBe(core.version);
    expect(alias.dependencies[core.name]).toBe(core.version);
  });

  it("imports a declared export rather than reaching into dist/", () => {
    // Deep-importing dist/cli.js works only while the core has no exports map,
    // and would break the day the build output moves.
    expect(read("alias/bin.js")).toContain(`import "${core.name}/cli";`);
    expect(core.exports?.["./cli"]).toBe("./dist/cli.js");
  });

  it("ships the bin and keeps a shebang on it", () => {
    expect(alias.files).toContain("bin.js");
    expect(alias.bin.cclint).toBe("./bin.js");
    expect(read("alias/bin.js").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("claims the name the README tells people to run", () => {
    // If these ever disagree, the documented entry point 404s.
    expect(alias.name).toBe("cclint");
    expect(read("README.md")).toContain("npx cclint");
  });
});
