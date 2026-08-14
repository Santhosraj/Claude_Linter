import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { analyze } from "../src/analyze.js";

/**
 * `claude.md` instead of `CLAUDE.md`.
 *
 * Found by running cclint over a real project, where `model-overlays/claude.md`
 * was reported as `model-overlays\CLAUDE.md`: discovery probed for the canonical
 * name and Windows matched it case-insensitively, so the tool displayed a name
 * the file does not have. Claude Code matches `CLAUDE.md` literally, so that file
 * is memory on Windows and macOS and nothing at all on Linux or in CI — the
 * instructions in it stop applying with no signal anywhere.
 *
 * These tests only mean something on a case-INSENSITIVE filesystem, which is
 * where the bug exists: elsewhere the probe simply misses and there is nothing to
 * mis-report. They assert the contract that holds either way rather than skipping.
 */

const dirs: string[] = [];

function project(memoryName: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cclint-case-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, memoryName), "# Rules\n\n- Always write tests first.\n");
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const run = (dir: string) =>
  analyze({
    cwd: dir,
    home: join(dir, "__no_home__"),
    managedPolicyPath: join(dir, "__no_policy__.json"),
    skipBudget: true,
  });

describe("memory filename casing", () => {
  it("reports the name on disk, not the name it probed for", async () => {
    const dir = project("claude.md");
    const result = await run(dir);

    const found = result.context.discovery.memory.map((m) => basename(m.file));
    // The dangerous outcome is `CLAUDE.md` appearing here when no such file
    // exists — that is what made the file look correctly named.
    if (found.length > 0) {
      expect(found).toContain("claude.md");
      expect(found).not.toContain("CLAUDE.md");
    }
  });

  it("flags a case variant, naming both the found and expected spelling", async () => {
    const dir = project("claude.md");
    const result = await run(dir);

    const hits = result.diagnostics.filter((d) => d.ruleId === "memory/filename-case");
    if (result.context.discovery.memory.length === 0) return; // case-sensitive FS

    expect(hits).toHaveLength(1);
    expect(hits[0]?.data?.["found"]).toBe("claude.md");
    expect(hits[0]?.data?.["expected"]).toBe("CLAUDE.md");
    // The consequence has to be in the text; "differs by case" alone reads
    // cosmetic, and the reader needs to know it breaks elsewhere.
    expect(hits[0]?.detail?.join(" ")).toMatch(/case-sensitive/);
  });

  it("says nothing when the file is spelled correctly", async () => {
    const result = await run(project("CLAUDE.md"));
    expect(result.diagnostics.filter((d) => d.ruleId === "memory/filename-case")).toEqual([]);
  });

  it("is a warning, not an error — it works on the machine reporting it", async () => {
    const dir = project("claude.md");
    const result = await run(dir);
    if (result.context.discovery.memory.length === 0) return;

    const hit = result.diagnostics.find((d) => d.ruleId === "memory/filename-case");
    expect(hit?.severity).toBe("warning");
  });

  it("ignores an unrelated markdown file rather than guessing at intent", async () => {
    // `NOTES.md` is not a case variant of anything Claude Code loads, so it is
    // not discovered as memory and must not be flagged.
    const dir = project("CLAUDE.md");
    writeFileSync(join(dir, "NOTES.md"), "# Notes\n");
    const result = await run(dir);
    expect(result.diagnostics.filter((d) => d.ruleId === "memory/filename-case")).toEqual([]);
  });
});
