import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CLI argument validation.
 *
 * Every assertion here traces to one real incident: a Windows path containing
 * spaces was passed unquoted. The shell split it, so `--cwd` silently received
 * a truncated directory that did not exist, the leftover fragments arrived as
 * positionals the CLI discarded, and discovery walked up from the bad path until
 * it found an unrelated `.git` several levels above.
 *
 * The run then "succeeded": it reported no issues, scanned three unrelated
 * sibling projects, showed a per-turn floor of ~0 tokens, and never mentioned
 * the project's own settings.local.json. Self-consistent and entirely wrong,
 * which is the most dangerous output a linter can produce.
 */

const cli = resolve(__dirname, "..", "dist", "cli.js");
const built = existsSync(cli);

interface Run {
  stdout: string;
  stderr: string;
  status: number;
}

function run(args: string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

describe.skipIf(!built)("argument validation (requires npm run build)", () => {
  it("rejects a --cwd that does not exist instead of walking up from it", () => {
    const r = run(["doctor", "--cwd", "D:/definitely/not/here"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--cwd does not exist/);
  });

  it("suggests quoting when a path is rejected", () => {
    const r = run(["doctor", "--cwd", "D:/definitely/not/here"]);
    expect(r.stderr).toMatch(/contain spaces/i);
    expect(r.stderr).toMatch(/quotes/i);
  });

  it("rejects the stray positionals an unquoted path leaves behind", () => {
    // Exactly the shape of the original failure: the shell has already split
    // `--cwd "…/test-api copy"` into a truncated flag value plus a bare word.
    const r = run(["doctor", "--cwd", "D:/some/path/test-api", "copy"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unexpected argument/);
    expect(r.stderr).toMatch(/contain spaces/i);
  });

  it("rejects an unknown command rather than silently linting", () => {
    const r = run(["dcotor"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown command "dcotor"/);
  });

  it("still accepts a correctly quoted path with spaces", () => {
    const fixture = resolve(__dirname, "fixtures", "sample-project");
    const r = run([
      "doctor",
      "--cwd",
      fixture,
      "--home",
      join(fixture, ".fake-home"),
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/project root:/);
  });

  it("allows exactly one positional for explain", () => {
    const fixture = resolve(__dirname, "fixtures", "sample-project");
    const ok = run(["explain", "model", "--cwd", fixture, "--home", join(fixture, ".fake-home")]);
    expect(ok.status).toBe(0);

    const tooMany = run(["explain", "model", "extra", "--cwd", fixture]);
    expect(tooMany.status).toBe(2);
    expect(tooMany.stderr).toMatch(/Unexpected argument/);
  });
});

describe.skipIf(!built)("doctor explains its root choice", () => {
  const fixture = resolve(__dirname, "fixtures", "sample-project");

  it("names the marker that decided the root", () => {
    const r = run(["doctor", "--cwd", fixture, "--home", join(fixture, ".fake-home")]);
    expect(r.stdout).toMatch(/found \.claude here/);
  });

  it("warns when the root sits above the directory the user pointed at", () => {
    // Pointing at a subdirectory is legitimate, but the config there becomes
    // on-demand subtree memory and the per-turn floor reads ~0 — worth saying
    // out loud rather than letting the number mislead.
    const sub = join(fixture, "docs");
    const r = run(["doctor", "--cwd", sub, "--home", join(fixture, ".fake-home")]);
    expect(r.stdout).toMatch(/root is above the directory you pointed at/);
    expect(r.stdout).toMatch(/--project-root/);
  });

  it("reports a forced root as forced", () => {
    const r = run([
      "doctor",
      "--cwd",
      fixture,
      "--project-root",
      fixture,
      "--home",
      join(fixture, ".fake-home"),
    ]);
    expect(r.stdout).toMatch(/forced via --project-root/);
  });
});
