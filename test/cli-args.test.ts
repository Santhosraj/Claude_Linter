import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

describe.skipIf(!built)("reported version (requires npm run build)", () => {
  /**
   * The version was hardcoded in cli.ts, so `npm version 0.2.0` produced a build
   * that still called itself 0.1.0 — in `--version` and in every SARIF report,
   * where the tool version is what GitHub code scanning uses to track a finding
   * across runs. Caught by installing the packed tarball and asking it; nothing
   * in the suite would have.
   */
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };

  it("matches package.json, so a release cannot ship the previous number", () => {
    expect(run(["--version"]).stdout.trim()).toBe(pkg.version);
  });

  it("stamps the same version into SARIF, which consumers key history on", () => {
    const sarif = JSON.parse(run(["--format", "sarif", "--offline"]).stdout) as {
      runs: { tool: { driver: { version?: string; semanticVersion?: string } } }[];
    };
    const driver = sarif.runs[0]!.tool.driver;
    expect(driver.version ?? driver.semanticVersion).toBe(pkg.version);
  });
});

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

  it("shows the trust key when it differs from the project root", () => {
    // The fixture is rooted by its own `.claude`, while trust keys on the
    // enclosing git root — this repository. Without this line a reader comparing
    // doctor against a `permissions/untrusted-workspace` finding sees two
    // different paths and cannot tell that it is correct rather than a bug.
    const r = run(["doctor", "--cwd", fixture, "--home", join(fixture, ".fake-home")]);
    expect(r.stdout).toMatch(/trust key:/);
    expect(r.stdout).toMatch(/enclosing git root/);
  });

  it("omits the trust key when it is the same as the project root", () => {
    // Repeating the path would cost a scannable line for no information.
    const r = run(["doctor", "--cwd", resolve(__dirname, "..")]);
    expect(r.stdout).toMatch(/project root:/);
    expect(r.stdout).not.toMatch(/trust key:/);
  });

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
