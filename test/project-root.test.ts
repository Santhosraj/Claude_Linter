import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  discover,
  findProjectRoot,
  readWorkspaceTrust,
  trustKeyFor,
} from "../src/discovery/layers.js";

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

/**
 * Workspace trust is keyed on the GIT root, which is not always our project
 * root. `.claude` is a strong marker, so a subdirectory carrying one becomes our
 * root while Claude Code keeps walking up to the repository — verified by
 * repeated probes of 2.1.229, which ask for `projects["<git root>"]`. Keying on
 * our own root read the wrong `~/.claude.json` entry and printed remediation
 * naming a key the binary never reads, so following it left the warning up.
 */
describe("trustKeyFor", () => {
  it("walks up to the enclosing git root, past a nearer .claude", () => {
    const dir = scratch();
    mkdirSync(join(dir, ".git"));
    const nested = join(dir, "packages", "app");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(nested, ".claude"));

    // findProjectRoot stops at the nearer .claude; trust must not.
    expect(findProjectRoot(nested)).toBe(resolve(nested));
    expect(trustKeyFor(nested)).toBe(resolve(dir));
  });

  it("treats a `.git` FILE as a root, for worktrees and submodules", () => {
    // A worktree's `.git` is a file holding a `gitdir:` pointer. Requiring a
    // directory would silently fall back to the wrong key for anyone using one.
    const dir = scratch();
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    const nested = join(dir, "sub");
    mkdirSync(nested);

    expect(trustKeyFor(nested)).toBe(resolve(dir));
  });

  it("returns an enclosing git root, or the project root when there is none", () => {
    const dir = scratch();
    const project = join(dir, "proj");
    mkdirSync(project);

    /**
     * Asserting the fallback directly is not portable: the OS temp directory can
     * itself sit inside a repository — a home-directory dotfiles repo does it,
     * and on this machine `C:\Users\Dell` is one, which is precisely why an early
     * probe reported `projects["C:/Users/Dell"]` for a scratch directory. There
     * the fallback is unobservable rather than wrong, so this asserts the
     * contract that holds either way.
     */
    const key = trustKeyFor(project);
    if (key === project) return; // no enclosing repo — fell back as intended
    expect(existsSync(join(key, ".git")), `${key} should hold a .git`).toBe(true);
    expect(project.startsWith(key), `${key} should be an ancestor`).toBe(true);
  });
});

describe("readWorkspaceTrust", () => {
  function storeWith(projects: unknown): string {
    const home = scratch();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects }));
    return home;
  }

  /**
   * The store is keyed on `trustKeyFor(project)`, not on the project directory —
   * that IS the behaviour under test. On a machine whose temp directory sits
   * inside a repository the two differ, and keying on the project would make
   * these cases silently exercise the no-match path instead.
   */
  const keyFor = (project: string) => trustKeyFor(project).split("\\").join("/");

  it("matches the project key case- and separator-insensitively", () => {
    const project = scratch();
    const home = storeWith({ [keyFor(project).toUpperCase()]: { hasTrustDialogAccepted: true } });
    expect(readWorkspaceTrust(home, project).trusted).toBe(true);
  });

  it("reports unknown when duplicate keys for one directory disagree", () => {
    // A real store holds both `D:/x` and `d:/x` for the same directory, and they
    // can carry opposite flags. Returning the first hit made the answer depend on
    // object key order — insertion order, unrelated to what the binary reads — so
    // the same store could yield either verdict. `undefined` makes the rule stay
    // silent instead of confidently reporting a live allow list as dead.
    const project = scratch();
    const key = keyFor(project);
    const home = storeWith({
      [key]: { hasTrustDialogAccepted: false },
      [key.toUpperCase()]: { hasTrustDialogAccepted: true },
    });
    expect(readWorkspaceTrust(home, project).trusted).toBeUndefined();
  });

  it("still answers when duplicate keys agree", () => {
    const project = scratch();
    const key = keyFor(project);
    const home = storeWith({
      [key]: { hasTrustDialogAccepted: true },
      [key.toUpperCase()]: { hasTrustDialogAccepted: true },
    });
    expect(readWorkspaceTrust(home, project).trusted).toBe(true);
  });

  it("treats a missing store as untrusted, not unknown", () => {
    // Matches the binary, which gates allow entries in exactly this situation.
    expect(readWorkspaceTrust(scratch(), scratch()).trusted).toBe(false);
  });
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
