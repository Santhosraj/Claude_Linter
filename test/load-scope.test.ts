import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { analyze } from "../src/analyze.js";
import { ALWAYS, sharedLoadScope } from "../src/model/load-scope.js";

/**
 * Pairing rules must ask whether two files are ever in context together.
 *
 * Found by linting real projects inside one large repository. Every nested
 * CLAUDE.md was treated as always loaded, so a rule in one client project was
 * reported as "already stated in another CLAUDE.md that is also always in
 * context" — pointing at an unrelated project Claude Code never loads while
 * working in the first. 44 such findings across three projects, all false. The
 * budget module already modelled nested files as on demand; the rules did not.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cclint-scope-"));
  dirs.push(root);
  mkdirSync(join(root, ".claude"));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

const run = (root: string) =>
  analyze({
    cwd: root,
    home: join(root, "__no_home__"),
    managedPolicyPath: join(root, "__no_policy__.json"),
    skipBudget: true,
    strict: true,
  });

const RULE = "- Always run the contract tests before committing.\n";

describe("duplicates across nested CLAUDE.md files", () => {
  it("does not report copies in sibling subtrees", async () => {
    const root = tree({ "clients/a/CLAUDE.md": RULE, "clients/b/CLAUDE.md": RULE });
    const result = await run(root);
    expect(result.diagnostics.filter((d) => d.ruleId === "memory/redundant-across-layers")).toEqual([]);
  });

  it("reports a nested copy, and says WHERE both are loaded rather than 'every turn'", async () => {
    const root = tree({ "CLAUDE.md": RULE, "api/CLAUDE.md": RULE });
    const found = (await run(root)).diagnostics.filter((d) => d.ruleId === "memory/redundant-across-layers");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toMatch(/loads alongside it under api/);
    expect(found[0]?.detail?.join(" ")).toMatch(/whenever Claude works under api/);
    expect(found[0]?.detail?.join(" ")).not.toMatch(/every turn/);
  });

  it("reports a directory nested inside another", async () => {
    const root = tree({ "api/CLAUDE.md": RULE, "api/billing/CLAUDE.md": RULE });
    const found = (await run(root)).diagnostics.filter((d) => d.ruleId === "memory/redundant-across-layers");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toMatch(/under api[\\/]billing/);
  });

  it("keeps the 'every turn' wording when both files really are always loaded", async () => {
    const root = tree({ "CLAUDE.md": RULE, ".claude/CLAUDE.md": RULE });
    const found = (await run(root)).diagnostics.filter((d) => d.ruleId === "memory/redundant-across-layers");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toMatch(/also always in context/);
  });

  it("gives an imported file the scope of the CLAUDE.md that imports it", async () => {
    // a/extra.md loads only with a/CLAUDE.md, so it is a sibling of b/ too.
    const root = tree({
      "a/CLAUDE.md": "@extra.md\n",
      "a/extra.md": RULE,
      "b/CLAUDE.md": RULE,
    });
    const result = await run(root);
    expect(result.diagnostics.filter((d) => d.ruleId === "memory/redundant-across-layers")).toEqual([]);
  });
});

describe("axis conflicts across nested CLAUDE.md files", () => {
  it("does not report different conventions in sibling subtrees — that is their purpose", async () => {
    const root = tree({
      "frontend/CLAUDE.md": "- Use tabs for indentation.\n",
      "backend/CLAUDE.md": "- Never use tabs; use spaces for indentation.\n",
    });
    const found = (await run(root)).diagnostics.filter((d) => d.ruleId === "memory/axis-conflict");
    expect(found).toEqual([]);
  });

  it("reports a nested file contradicting the root, scoped to where both load", async () => {
    const root = tree({
      "CLAUDE.md": "- Use tabs for indentation.\n",
      "backend/CLAUDE.md": "- Never use tabs; use spaces for indentation.\n",
    });
    const found = (await run(root)).diagnostics.filter((d) => d.ruleId === "memory/axis-conflict");
    expect(found).toHaveLength(1);
    expect(found[0]?.detail?.join(" ")).toMatch(/whenever Claude works under backend/);
  });
});

describe("sharedLoadScope", () => {
  it("is ALWAYS when neither file is scoped", () => {
    expect(sharedLoadScope(undefined, undefined)).toBe(ALWAYS);
  });

  it("is the scoped file's directory when only one is scoped", () => {
    expect(sharedLoadScope(undefined, "/p/api")).toBe("/p/api");
    expect(sharedLoadScope("/p/api", undefined)).toBe("/p/api");
  });

  it("is the deeper directory when one contains the other", () => {
    expect(sharedLoadScope("/p/api", "/p/api/billing")).toBe("/p/api/billing");
  });

  it("is undefined for siblings, including ones sharing a name prefix", () => {
    expect(sharedLoadScope("/p/a", "/p/b")).toBeUndefined();
    // A plain string-prefix check would call /p/api-v2 "inside" /p/api.
    expect(sharedLoadScope("/p/api", "/p/api-v2")).toBeUndefined();
  });
});
