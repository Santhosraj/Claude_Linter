import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { discover, findProjectRoot } from "../src/discovery/layers.js";

/**
 * Project-root detection.
 *
 * Two failure modes pull in opposite directions, which is why marker strength
 * exists:
 *
 *   - Too strict (only .git / .claude): a scratch folder holding just a
 *     CLAUDE.md is walked straight past, and the PARENT's config is linted
 *     instead — silently reporting on the wrong project.
 *   - Too loose (CLAUDE.md counts everywhere): running inside a monorepo package
 *     that has its own nested CLAUDE.md resolves the root to that package, so
 *     the repo's real settings and root CLAUDE.md disappear from discovery.
 */

const roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "cclint-root-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("findProjectRoot", () => {
  it("uses a bare CLAUDE.md directory as the root when nothing stronger exists", () => {
    const dir = scratch();
    const project = join(dir, "notes");
    mkdirSync(project);
    writeFileSync(join(project, "CLAUDE.md"), "# Notes\n\n- Always be careful.\n");

    expect(findProjectRoot(project)).toBe(resolve(project));
  });

  it("also accepts .mcp.json or .cclint.json as a weak marker", () => {
    for (const marker of [".mcp.json", ".cclint.json"]) {
      const dir = scratch();
      const project = join(dir, "proj");
      mkdirSync(project);
      writeFileSync(join(project, marker), "{}\n");
      expect(findProjectRoot(project)).toBe(resolve(project));
    }
  });

  it("prefers a .git ancestor over a nearer nested CLAUDE.md", () => {
    // The monorepo regression. This is the case a naive fix breaks.
    const dir = scratch();
    const repo = join(dir, "repo");
    const pkg = join(repo, "packages", "api");
    mkdirSync(pkg, { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, "CLAUDE.md"), "# Repo\n");
    writeFileSync(join(pkg, "CLAUDE.md"), "# Package\n");

    expect(findProjectRoot(pkg)).toBe(resolve(repo));
  });

  it("prefers a .claude ancestor over a nearer nested CLAUDE.md", () => {
    const dir = scratch();
    const repo = join(dir, "repo");
    const sub = join(repo, "sub");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(sub, "CLAUDE.md"), "# Sub\n");

    expect(findProjectRoot(sub)).toBe(resolve(repo));
  });

  it("returns the starting directory when there is no marker at all", () => {
    const dir = scratch();
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(findProjectRoot(empty)).toBe(resolve(empty));
  });
});

describe("the home directory is never a project root", () => {
  it("does not let ~/.claude mark $HOME as a project", () => {
    // Real-world bug this guards: running from any non-git folder under $HOME
    // walked up, hit ~/.claude, and declared $HOME the project root.
    const dir = scratch();
    const home = join(dir, "home");
    const work = join(home, "scratchpad");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(work);

    expect(findProjectRoot(work, home)).toBe(resolve(work));
  });

  it("never admits one physical file into two layers", () => {
    // Forcing the root to $HOME makes the user and project settings paths
    // identical. Admitting both would make the resolver report the file as
    // shadowing itself.
    const dir = scratch();
    const home = join(dir, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), '{"model":"opus"}\n');
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# Home\n\n- Always be careful.\n");

    const found = discover({
      cwd: home,
      projectRoot: home,
      home,
      managedPolicyPath: join(dir, "no-policy.json"),
    });

    const settingsPaths = found.settings.map((s) => resolve(s.file));
    expect(new Set(settingsPaths).size).toBe(settingsPaths.length);

    const memoryPaths = found.memory.map((m) => resolve(m.file));
    expect(new Set(memoryPaths).size).toBe(memoryPaths.length);

    // The path belongs to the layer it genuinely is: user, not project.
    expect(found.settings.find((s) => s.file.includes(".claude"))?.layer).toBe("user");
  });
});

describe("discover honours an explicit projectRoot", () => {
  it("skips detection entirely when the root is forced", () => {
    const dir = scratch();
    const repo = join(dir, "repo");
    const sub = join(repo, "sub");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(sub, "CLAUDE.md"), "# Sub\n");

    const forced = discover({
      cwd: sub,
      projectRoot: sub,
      home: join(dir, "no-home"),
      managedPolicyPath: join(dir, "no-policy.json"),
    });
    expect(forced.projectRoot).toBe(resolve(sub));

    // Same cwd, detection on: resolves to the repo instead.
    const detected = discover({
      cwd: sub,
      home: join(dir, "no-home"),
      managedPolicyPath: join(dir, "no-policy.json"),
    });
    expect(detected.projectRoot).toBe(resolve(repo));
  });

  it("finds the CLAUDE.md in a scratch folder that previously produced nothing", () => {
    const dir = scratch();
    const project = join(dir, "solo");
    mkdirSync(project);
    writeFileSync(join(project, "CLAUDE.md"), "# Solo\n\n- Always use tabs.\n");

    const found = discover({
      cwd: project,
      home: join(dir, "no-home"),
      managedPolicyPath: join(dir, "no-policy.json"),
    });

    expect(found.projectRoot).toBe(resolve(project));
    expect(found.memory.map((m) => m.file)).toContain(join(project, "CLAUDE.md"));
    // And it is treated as project memory, not as an incidental nested file.
    expect(found.memory.find((m) => m.file === join(project, "CLAUDE.md"))?.layer).toBe(
      "project",
    );
  });
});
